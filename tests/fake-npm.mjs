// Поддельный npm для `deps.test.ts`: `scripts/deps.ts` зовёт его вместо настоящего (`npm_execpath`)
// с каталогом пакета текущим. Каждый вызов пишется строкой в `npm.log`. Поведение задаёт тест
// переменной `DEPS_TEST_NPM`:
//
// - `install` — как `npm ci`: сносит `node_modules`, собирает заново и ставит метку целого дерева
//   `node_modules/.complete`; пока в каталоге нет файла `gate`, установка стоит посередине;
// - `fail` — отказ до установки, дерево не тронуто, как `npm ci` на разошедшихся `package.json` и
//   замке;
// - `interrupt` — установка начала разбирать дерево (метки целого дерева уже нет), и тут скрипт
//   установки убит.

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

appendFileSync("npm.log", `${process.argv.slice(2).join(" ")}\n`)

const mode = process.env.DEPS_TEST_NPM

if (mode === "fail") {
  process.exit(1)
}

if (mode === "interrupt") {
  rmSync("node_modules/.complete", { force: true })
  process.kill(process.ppid, "SIGKILL")
  process.exit(1)
}

if (mode !== "install") {
  process.stderr.write(`поддельный npm: незнакомое поведение ${String(mode)}\n`)
  process.exit(2)
}

rmSync("node_modules", { recursive: true, force: true })
mkdirSync("node_modules")
process.stdout.write("поддельный npm: установка идёт\n")

// Тест открывает ворота сам; потолок — чтобы упавший тест не оставил процесс ждать вечно.
const deadline = Date.now() + 10_000
while (!existsSync("gate")) {
  if (Date.now() > deadline) {
    process.stderr.write("поддельный npm: ворота так и не открылись\n")
    process.exit(2)
  }

  await sleep(10)
}

writeFileSync("node_modules/.complete", "")
