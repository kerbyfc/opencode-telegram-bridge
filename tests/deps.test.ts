// Установка зависимостей `scripts/deps.ts` на временном каталоге пакета: скрипт настоящий, подменён
// только npm. Каталог пакета и npm скрипт берёт из окружения, которое npm даёт скрипту пакета
// (`npm_package_json`, `npm_execpath`), и тест подаёт туда свой каталог и поддельный npm
// (`fake-npm.mjs`): тот пишет каждый вызов в журнал — по нему видно, сколько раз шла установка, — и
// по просьбе теста ставит дерево, отказывает или обрывает установку, убивая сам скрипт.
//
// Скрипт гоняется на месте, где `node_modules` уже поставлен, поэтому импорт пакета в его графе
// прогоны не поймали бы — а в чистом клоне он ронял бы установку до `npm ci`. Это держит первый
// тест: он читает исходник и пускает в импорты только модули `node:`.
//
// Запуск: `npm test` в корне репозитория.

import assert from "node:assert/strict"
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type TestContext, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

import ts from "typescript"

const DEPS = path.resolve(import.meta.dirname, "..", "scripts", "deps.ts")
const FAKE_NPM = path.resolve(import.meta.dirname, "fake-npm.mjs")

/** Чем ответит поддельный npm: поставит дерево, откажет или оборвёт установку. */
type Mode = "install" | "fail" | "interrupt"

/** Установка, запущенная фоном: вывод копится по мере прихода, код выхода — обещанием. */
type Running = { readonly output: () => string; readonly exit: Promise<number | null> }

/** Файлы временного каталога пакета, на которые смотрят проверки. */
const at = {
  lock: (root: string) => path.join(root, ".deps-lock"),
  stamp: (root: string) => path.join(root, "node_modules", ".deps-stamp"),
  complete: (root: string) => path.join(root, "node_modules", ".complete"),
  gate: (root: string) => path.join(root, "gate"),
  log: (root: string) => path.join(root, "npm.log"),
}

/** bench — временный каталог пакета: `package.json`, замок и открытые ворота поддельной установки. */
function bench(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "dmtg-deps-"))

  writeFileSync(path.join(root, "package.json"), `{ "name": "bench", "version": "1.0.0" }\n`)
  writeFileSync(path.join(root, "package-lock.json"), `{ "name": "bench", "version": "1.0.0", "lockfileVersion": 3 }\n`)
  writeFileSync(at.gate(root), "")
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  return root
}

/** bump — сменить версию в одном файле пакета, как правка состава. */
function bump(root: string, name: "package.json" | "package-lock.json"): void {
  const file = path.join(root, name)

  writeFileSync(file, readFileSync(file, "utf8").replace(`"1.0.0"`, `"1.0.1"`))
}

/** env — окружение скрипта пакета, как его даёт npm, но с поддельным npm. */
function env(root: string, mode: Mode, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_execpath: FAKE_NPM,
    npm_package_json: path.join(root, "package.json"),
    DEPS_TEST_NPM: mode,
    ...extra,
  }
}

/**
 * run — прогнать установку до конца. Дольше десяти секунд она не идёт ни в одном тесте: зависшую
 * `spawnSync` убивает, и тест падает на коде выхода, а не висит.
 */
function run(root: string, mode: Mode = "install", extra: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", DEPS], {
    cwd: root,
    encoding: "utf8",
    env: env(root, mode, extra),
    timeout: 10_000,
  })
}

/** start — запустить установку фоном; тест по выходе добивает её, если она ещё идёт. */
function start(t: TestContext, root: string): Running {
  const child = spawn(process.execPath, ["--experimental-strip-types", DEPS], {
    cwd: root,
    env: env(root, "install"),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    out += chunk
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    out += chunk
  })

  const exit = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      resolve(code)
    })
  })

  t.after(() => {
    child.kill()
  })

  return { output: () => out, exit }
}

/** calls — сколько раз звали npm. */
function calls(root: string): number {
  const log = at.log(root)

  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length : 0
}

/** locks — файлы блокировки в каталоге пакета: сама блокировка и права снять мёртвую. */
function locks(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith(".deps-lock"))
}

/** count — у скольких прогонов в выводе есть `text`. */
function count(runs: readonly Running[], text: string): number {
  return runs.filter((one) => one.output().includes(text)).length
}

/** until — дождаться условия; не дождались за десять секунд — тест падает с тем, чего ждали, и выводом прогонов. */
async function until(what: string, runs: readonly Running[], check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000

  while (!check()) {
    if (Date.now() > deadline) {
      const outputs = runs.map((one, index) => `--- прогон ${String(index + 1)}:\n${one.output()}`)

      assert.fail(`не дождались: ${what}\n${outputs.join("\n")}`)
    }

    await sleep(10)
  }
}

/** deadPid — pid процесса, который уже кончился. */
function deadPid(): number {
  const gone = spawnSync(process.execPath, ["-e", ""])

  assert.equal(gone.status, 0)

  return gone.pid
}

test("установка импортирует только модули node: — она идёт раньше, чем пакеты поставлены", () => {
  // Сканер импортов самого TypeScript: видит и многострочные, и голые, и динамические импорты и
  // реэкспорты, а комментарии и строки пропускает.
  const imports = ts.preProcessFile(readFileSync(DEPS, "utf8"), true, true).importedFiles.map((file) => file.fileName)

  assert.ok(imports.length > 0, "в scripts/deps.ts не найдено ни одного импорта: сканер файла не видит")
  assert.deepEqual(
    imports.filter((name) => !name.startsWith("node:")),
    [],
    "scripts/deps.ts импортирует не только модули node: — в чистом клоне установка упадёт до npm ci",
  )
})

test("установка идёт по отпечатку package.json и замка: правка любого из них ведёт в npm ci", (t) => {
  const root = bench(t)

  assert.equal(run(root).status, 0)
  assert.equal(readFileSync(at.log(root), "utf8"), "ci --ignore-scripts --no-audit --no-fund\n")

  assert.equal(run(root).status, 0)
  assert.equal(calls(root), 1, "при целом отпечатке установка повторилась")

  bump(root, "package.json")
  assert.equal(run(root).status, 0)
  assert.equal(calls(root), 2, "правка одного package.json в npm ci не повела")

  bump(root, "package-lock.json")
  assert.equal(run(root).status, 0)
  assert.equal(calls(root), 3, "правка одного замка в npm ci не повела")
})

test("отказ npm ci доходит до прогона: код 1, отпечатка нет, блокировка снята", (t) => {
  const root = bench(t)

  assert.equal(run(root).status, 0)

  // `package.json` разошёлся с замком: настоящий `npm ci` на этом отказывает.
  bump(root, "package.json")
  const refused = run(root, "fail")

  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /npm ci не прошёл: код 1/)
  assert.equal(existsSync(at.stamp(root)), false, "отказ оставил отпечаток")
  assert.deepEqual(locks(root), [], "блокировка осталась")
})

test("второй прогон посреди установки первого ждёт блокировку и установку не повторяет", async (t) => {
  const root = bench(t)

  // Пока ворот нет, установка первого стоит посередине — второй приходит именно в это окно.
  rmSync(at.gate(root))

  const first = start(t, root)
  await until("первый прогон начал установку", [first], () => first.output().includes("установка идёт"))

  const second = start(t, root)
  await until("второй прогон ждёт блокировку", [first, second], () => second.output().includes("— жду до"))

  writeFileSync(at.gate(root), "")

  const codes = await Promise.all([first.exit, second.exit])

  assert.deepEqual(codes, [0, 0], `${first.output()}\n${second.output()}`)
  assert.equal(calls(root), 1, "npm ci прошла не один раз")
  assert.ok(existsSync(at.complete(root)), "дерево не собрано до конца")
  assert.deepEqual(locks(root), [], "блокировка осталась")

  assert.equal(run(root).status, 0)
  assert.equal(calls(root), 1, "следующий прогон отпечатку не поверил")
})

test("блокировка завершившегося процесса снимается, и установка идёт", (t) => {
  const root = bench(t)
  const dead = deadPid()

  writeFileSync(at.lock(root), `${String(dead)}\n`)

  const result = run(root)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`процесса ${String(dead)} — снята`), result.stdout)
  assert.equal(calls(root), 1)
  assert.deepEqual(locks(root), [], "блокировка осталась")
})

test("право снять мёртвую блокировку, брошенное умершим снимавшим, снимается тем же порядком", (t) => {
  const root = bench(t)
  const owner = deadPid()
  const remover = deadPid()

  writeFileSync(at.lock(root), `${String(owner)}\n`)
  writeFileSync(`${at.lock(root)}.${String(owner)}`, `${String(remover)}\n`)

  const result = run(root)

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`процесса ${String(remover)} — снята`), result.stdout)
  assert.ok(result.stdout.includes(`процесса ${String(owner)} — снята`), result.stdout)
  assert.equal(calls(root), 1)
  assert.deepEqual(locks(root), [], "блокировка или право осталось")
})

test("живую чужую блокировку ждут до потолка и отказывают, назвав её pid и срок", (t) => {
  const root = bench(t)
  // Блокировку держит сам процесс теста: он жив всё время, пока установка его ждёт.
  const foreign = `${String(process.pid)}\n`

  writeFileSync(at.lock(root), foreign)

  const refused = run(root, "install", {
    DM_TELEGRAM_OPENCODE_DEPS_WAIT_SECONDS: "1",
    DM_TELEGRAM_OPENCODE_DEPS_POLL_SECONDS: "0.05",
  })

  assert.equal(refused.status, 1, `${String(refused.signal)}\n${refused.stdout}\n${refused.stderr}`)
  assert.match(refused.stdout, /жду до 1 с/)
  assert.match(refused.stderr, new RegExp(`держит процесс ${String(process.pid)}: ждали \\d+ с — установку не начинаю`))
  assert.equal(readFileSync(at.lock(root), "utf8"), foreign, "чужая блокировка тронута")
  assert.deepEqual(locks(root), [".deps-lock"])
  assert.equal(calls(root), 0, "npm ci звался при чужой блокировке")
})

test("негодный потолок или шаг ожидания — отказ с причиной до блокировки", (t) => {
  const root = bench(t)

  for (const [name, bad] of [
    ["DM_TELEGRAM_OPENCODE_DEPS_WAIT_SECONDS", "много"],
    ["DM_TELEGRAM_OPENCODE_DEPS_POLL_SECONDS", "0"],
  ] as const) {
    const refused = run(root, "install", { [name]: bad })

    assert.equal(refused.status, 1, refused.stderr)
    assert.ok(refused.stderr.includes(`${name}=${bad}: ждали положительное число`), refused.stderr)
  }

  assert.deepEqual(locks(root), [], "блокировка взята при негодном значении")
  assert.equal(calls(root), 0, "npm ci звался при негодном значении")
})

test("мёртвую блокировку четырёх прогонов разом снимает один, ставит один, трое ждут", async (t) => {
  const root = bench(t)

  writeFileSync(at.lock(root), `${String(deadPid())}\n`)
  rmSync(at.gate(root))

  const runs = [start(t, root), start(t, root), start(t, root), start(t, root)]

  await until(
    "один прогон ставит, трое ждут",
    runs,
    () => count(runs, "установка идёт") === 1 && count(runs, "— жду до") === 3,
  )
  writeFileSync(at.gate(root), "")

  const codes = await Promise.all(runs.map((one) => one.exit))
  const outputs = runs.map((one) => one.output()).join("\n")

  assert.deepEqual(codes, [0, 0, 0, 0], outputs)
  assert.equal(count(runs, "— снята"), 1, outputs)
  assert.equal(calls(root), 1, "npm ci прошла не один раз")
  assert.ok(existsSync(at.complete(root)), "дерево не собрано до конца")
  assert.deepEqual(locks(root), [], "блокировка осталась")
})

test("оборванная установка не оставляет отпечатка, и следующий прогон ставит заново", (t) => {
  const root = bench(t)
  const manifest = path.join(root, "package.json")
  const before = readFileSync(manifest, "utf8")

  // Целое дерево с отпечатком, потом состав сменился — нужна установка, и её обрывают.
  assert.equal(run(root).status, 0)
  bump(root, "package.json")

  const cut = run(root, "interrupt")

  assert.notEqual(cut.status, 0, "оборванная установка вышла нулём")
  assert.equal(existsSync(at.stamp(root)), false, "оборванная установка оставила отпечаток")
  assert.deepEqual(locks(root), [".deps-lock"], "после убитого скрипта в каталоге не одна его блокировка")

  // Состав вернулся к тому, с которым отпечаток был: дерево всё равно разобрано, и ставить надо.
  writeFileSync(manifest, before)

  const again = run(root)

  assert.equal(again.status, 0, again.stderr)
  assert.equal(calls(root), 3, "после обрыва установка заново не пошла")
  assert.ok(existsSync(at.complete(root)), "дерево не собрано до конца")
  assert.deepEqual(locks(root), [], "блокировка убитого скрипта осталась")
})
