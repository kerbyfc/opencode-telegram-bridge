#!/usr/bin/env node
// Поддельная подкоманда `link` для `link.test.ts`: тест называет её в `DM_TELEGRAM_BRIDGE`. Каждый
// запуск дописывает строку в файл `FAKE_LINK_COUNT` — по нему тест считает запуски — и берёт из
// `FAKE_LINK_PLAN` (массив JSON) свой шаг по номеру запуска; последний шаг повторяется. Шаг — строки
// выдачи (`lines`) и код выхода (`code`); без кода подкоманда живёт, пока её не погасят, как живёт
// настоящая, переживающая потерю связи со службой.

import { appendFileSync, readFileSync } from "node:fs"

const counter = String(process.env.FAKE_LINK_COUNT)

appendFileSync(counter, `${process.argv.slice(2).join(" ")}\n`)

const run = readFileSync(counter, "utf8").split("\n").filter((line) => line !== "").length
const plan = JSON.parse(String(process.env.FAKE_LINK_PLAN))
const step = plan[Math.min(run, plan.length) - 1]

for (const line of step.lines) {
  process.stdout.write(`${line}\n`)
}

if (step.code === undefined) {
  setInterval(() => undefined, 1000)
} else {
  // Выход после того, как выдача ушла: иначе процесс кончился бы раньше, чем плагин её прочёл.
  process.stdout.write("", () => process.exit(step.code))
}
