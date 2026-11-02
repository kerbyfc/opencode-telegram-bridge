// Установка зависимостей плагина. `npm run typecheck` и `npm test` зовут её первым шагом, поэтому из
// чистого клона они идут без `npm ci` руками: `node_modules` в git не лежит, и без этого шага
// проверка типов упиралась бы в «пакетов нет».
//
// Ставится ровно то, что записано в замке `package-lock.json` (`npm ci`, а не `npm install`: тот
// правит замок), и только когда установленное разошлось с `package.json` или замком. Признак —
// отпечаток обоих файлов в `node_modules/.deps-stamp`: его сверка стоит миллисекунды, а `npm ci` —
// секунды. Проверка «каталог есть» пропускала бы ровно тот случай, что приходит с `git pull`: замок
// уехал вперёд, каталог на месте. `package.json` в отпечатке потому, что `npm ci` сверяет его с
// замком: правка одного `package.json` ведёт в установку, и их расхождение становится отказом
// `npm ci` в своём же прогоне, а не у первого чистого клона.
//
// Отпечаток есть — установка целая: он стирается до `npm ci` и пишется только после её успеха, так
// что оборванная установка оставляет дерево без отпечатка, и следующий прогон ставит заново.
//
// Прогоны в одном каталоге делят установку блокировкой — файлом `.deps-lock` рядом с
// `node_modules`: он создаётся атомарно (флаг `wx`), внутри — pid владельца. Сверка отпечатка и
// установка идут только под ней: без неё `npm ci` второго прогона сносила бы `node_modules` из-под
// первого, а первый писал бы отпечаток разобранному дереву. Дождавшийся прогон сверяет отпечаток
// заново и установку соседа не повторяет. Блокировку завершившегося процесса снимает один из тех, кто
// её застал (`clear`); живую ждут не дольше `WAIT_SECONDS` и потом отказывают, назвав владельца и
// срок.
//
// Скрипты пакетов не запускаются (`--ignore-scripts`): типам нужны одни объявления, а чужой код,
// исполняющийся при `npm test`, им не нужен. Оба пути берутся из окружения, которое npm даёт скрипту
// пакета: каталог пакета (`npm_package_json`) и сам npm (`npm_execpath`). Установка идёт раньше, чем
// пакеты поставлены, поэтому импортирует только модули `node:` — это держит `tests/deps.test.ts`.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * Потолок ожидания живой чужой блокировки в секундах — по умолчанию пять минут. Установка идёт
 * секунды, холодная — десятки секунд; дольше блокировку держит прогон, который уже не кончится, и
 * ждать его вечно нельзя. Тесты ставят потолок в секунду-другую.
 */
const WAIT_SECONDS = seconds("DM_TELEGRAM_OPENCODE_DEPS_WAIT_SECONDS", 300)

/** Шаг в секундах, с которым ждущий прогон смотрит, не снята ли блокировка. */
const POLL_SECONDS = seconds("DM_TELEGRAM_OPENCODE_DEPS_POLL_SECONDS", 0.2)

/** Файлы, по которым `npm ci` ставит дерево: они и входят в отпечаток. */
const SOURCES = ["package.json", "package-lock.json"]

const NPM = fromNpm("npm_execpath")
const ROOT = path.dirname(fromNpm("npm_package_json"))
const STAMP = path.join(ROOT, "node_modules", ".deps-stamp")
const LOCK = path.join(ROOT, ".deps-lock")

/** Владелец блокировки по её файлу: pid или содержимое, в котором целой строки pid ещё нет. */
type Holder = { readonly pid: number } | { readonly raw: string }

/** seconds — число секунд из окружения: пусто — `fallback`, негодное — отказ с именем и значением. */
function seconds(
  name: "DM_TELEGRAM_OPENCODE_DEPS_WAIT_SECONDS" | "DM_TELEGRAM_OPENCODE_DEPS_POLL_SECONDS",
  fallback: number,
): number {
  const named = process.env[name]
  if (named === undefined || named === "") {
    return fallback
  }

  const value = Number(named)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}=${named}: ждали положительное число`)
  }

  return value
}

/** fromNpm — путь из окружения скрипта пакета; без него файл запущен не через npm. */
function fromNpm(name: "npm_execpath" | "npm_package_json"): string {
  const value = process.env[name]
  if (value === undefined || value === "") {
    throw new Error(`зависимости ставит npm: запускай \`npm run deps\`, а не файл напрямую (нет ${name})`)
  }

  return value
}

/** errno — код системной ошибки; у прочих ошибок его нет. */
function errno(failure: unknown): string | undefined {
  return (failure as NodeJS.ErrnoException).code
}

/** readOptional — текст файла; `undefined` — файла нет. */
function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch (failure) {
    if (errno(failure) === "ENOENT") {
      return undefined
    }

    throw failure
  }
}

/** say — строка о ходе установки в вывод прогона. */
function say(line: string): void {
  process.stdout.write(`[telegram-plugin] ${line}\n`)
}

/** fingerprint — отпечаток `package.json` и замка: по строке на файл, как у `sha256sum`. */
function fingerprint(): string {
  return SOURCES.map((name) => {
    const sum = createHash("sha256").update(readFileSync(path.join(ROOT, name))).digest("hex")

    return `${sum}  ${name}\n`
  }).join("")
}

/** holder — владелец блокировки `file`; `undefined` — файла нет. */
function holder(file: string): Holder | undefined {
  const text = readOptional(file)
  if (text === undefined) {
    return undefined
  }

  // Файл создаётся пустым и pid дописывается следом: строка без перевода в конце ещё пишется.
  const pid = /^([1-9]\d*)\n$/.exec(text)?.[1]

  return pid === undefined ? { raw: text } : { pid: Number(pid) }
}

/** describe — владелец блокировки словами для строк вывода. */
function describe(held: Holder): string {
  return "pid" in held ? `процесс ${String(held.pid)}` : `файл без pid ${JSON.stringify(held.raw)}`
}

/** alive — жив ли процесс `pid`: сигнал 0 только проверяет, есть ли такой процесс, и на Windows тоже. */
function alive(pid: number): boolean {
  // Свою блокировку этот процесс ещё не брал: его pid в файле — от умершего владельца с тем же номером.
  if (pid === process.pid) {
    return false
  }

  try {
    process.kill(pid, 0)

    return true
  } catch (failure) {
    if (errno(failure) === "ESRCH") {
      return false
    }

    // EPERM — процесс есть, но чужого пользователя: он жив.
    if (errno(failure) === "EPERM") {
      return true
    }

    throw failure
  }
}

/** claim — создать файл блокировки `file` со своим pid атомарно; `false` — файл уже есть. */
function claim(file: string): boolean {
  try {
    writeFileSync(file, `${String(process.pid)}\n`, { flag: "wx" })

    return true
  } catch (failure) {
    if (errno(failure) === "EEXIST") {
      return false
    }

    throw failure
  }
}

/** drop — снять свою блокировку `file`; чужая или пропавшая на этом месте — нарушенный инвариант. */
function drop(file: string): void {
  const held = holder(file)
  if (held === undefined || !("pid" in held) || held.pid !== process.pid) {
    throw new Error(`блокировка ${file} к снятию не своя: ${held === undefined ? "файла нет" : describe(held)}`)
  }

  unlinkSync(file)
}

/**
 * clear — снять блокировку `file`, владелец которой `dead` завершился; `false` — снимает другой
 * прогон, и надо подождать.
 *
 * Одну мёртвую блокировку застают сразу несколько прогонов. Удали её каждый по имени — опоздавший
 * удалил бы уже свежую блокировку того, кто успел снять мёртвую и взять свою, и установку вели бы
 * двое. Поэтому снимает один: тот, кто атомарно взял право на это — блокировку
 * `<файл>.<pid умершего>`, — и лишь проверив под ней, что в `file` всё ещё тот же умерший. Пока право
 * у него, `file` никто не тронет: владелец мёртв, а снять её можно только с этим правом. Умер с
 * правом в руках и снимавший — его право снимается так же, правом на право.
 */
function clear(file: string, dead: number): boolean {
  const right = `${file}.${String(dead)}`

  if (!claim(right)) {
    const other = holder(right)
    if (other !== undefined && "pid" in other && !alive(other.pid)) {
      clear(right, other.pid)
    }

    return false
  }

  try {
    const now = holder(file)
    if (now !== undefined && "pid" in now && now.pid === dead) {
      unlinkSync(file)
      say(`блокировка ${path.basename(file)} осталась от завершившегося процесса ${String(dead)} — снята`)
    }
  } finally {
    drop(right)
  }

  return true
}

/** acquire — взять блокировку установки: создать её файл или дождаться, пока прежний владелец её снимет. */
async function acquire(): Promise<void> {
  const since = Date.now()
  let told = false

  while (!claim(LOCK)) {
    const held = holder(LOCK)

    // Владелец снял блокировку между попыткой и чтением: пробуем снова сразу.
    if (held === undefined) {
      continue
    }

    const live = "pid" in held && alive(held.pid)
    if ("pid" in held && !live && clear(LOCK, held.pid)) {
      continue
    }

    const waited = Date.now() - since
    if (waited >= WAIT_SECONDS * 1000) {
      process.stderr.write(
        `[telegram-plugin] блокировку ${LOCK} держит ${describe(held)}: ждали ${String(Math.round(waited / 1000))} с — установку не начинаю\n`,
      )
      process.exit(1)
    }

    if (live && !told) {
      say(`установку ведёт ${describe(held)} — жду до ${String(WAIT_SECONDS)} с`)
      told = true
    }

    await sleep(POLL_SECONDS * 1000)
  }
}

/** sync — сверить дерево с отпечатком и, если разошлось, поставить заново; `false` — `npm ci` не прошёл. */
function sync(): boolean {
  const want = fingerprint()
  if (readOptional(STAMP) === want) {
    return true
  }

  // Установка разбирает дерево: отпечаток уходит до неё, а не вместе с ней.
  rmSync(STAMP, { force: true })
  say("node_modules не совпадает с package.json и package-lock.json — npm ci")

  const result = spawnSync(process.execPath, [NPM, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    const why =
      result.error?.message ?? (result.signal === null ? `код ${String(result.status)}` : `сигнал ${result.signal}`)

    process.stderr.write(`[telegram-plugin] npm ci не прошёл: ${why}\n`)

    return false
  }

  writeFileSync(STAMP, want)

  return true
}

await acquire()

try {
  process.exitCode = sync() ? 0 : 1
} finally {
  drop(LOCK)
}
