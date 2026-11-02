#!/usr/bin/env node
// Поддельный бинарь моста для `setup.test.ts`: тест называет его в `DM_TELEGRAM_BRIDGE`. Подкоманда
// `hook ask` пишет свою нагрузку строкой в файл `FAKE_BRIDGE_LOG` и отвечает так, как ответила бы
// настоящая при режиме сессии, названном `FAKE_BRIDGE_MODE`:
//
// - `on` — вопрос ушёл в тему: решение `deny` с причиной на стандартном выходе, код `0`;
// - `off` — режим снят: вывода нет, код `0`, и вопрос остаётся диалогом.
//
// Подкоманды `away on|off` пишут в тот же журнал свои аргументы и отвечают строкой включения или
// снятия; при `FAKE_BRIDGE_MODE=refuse` — отказом с причиной в потоке ошибок и ненулевым кодом.
//
// `FAKE_BRIDGE_AWAY_DELAY_MS` задерживает ответ `away`: так тест ловит доставку, пришедшую, пока
// команда режима ещё идёт.
//
// Подкоманда `link` при заданной `FAKE_BRIDGE_DELIVERY` печатает её строкой выдачи — доставкой слова
// владельца — и живёт, пока её не погасят; при заданном каталоге `FAKE_BRIDGE_INJECT` печатает так же
// каждый появившийся в нём файл `*.json` и удаляет его — тест подаёт слово, когда ему нужно. Без
// обеих, как и любая другая подкоманда, кончается сразу кодом `1`: соединения сессии тест не
// поднимает.

import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

/** Причина решения `deny`, как её получит модель; тест сверяет ту же строку. */
const REASON = "Вопрос отправлен владельцу в тему Telegram"

const argv = process.argv.slice(2)
const args = argv.join(" ")

// Команды режима: аргументы — строкой JSON в журнал, ответ — строкой, как у настоящей подкоманды.
if (argv[0] === "away") {
  appendFileSync(String(process.env.FAKE_BRIDGE_LOG), `${JSON.stringify({ argv })}\n`)

  await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_BRIDGE_AWAY_DELAY_MS ?? "0")))

  if (process.env.FAKE_BRIDGE_MODE === "refuse") {
    process.stderr.write("служба отказала: bad-request\n")
    process.exit(3)
  }

  process.stdout.write(argv[1] === "on" ? "режим включён, тема «проба» (7)\n" : "режим снят\n")
  process.exit(0)
}

const inject = process.env.FAKE_BRIDGE_INJECT

if (argv[0] === "link" && (process.env.FAKE_BRIDGE_DELIVERY !== undefined || inject !== undefined)) {
  if (process.env.FAKE_BRIDGE_DELIVERY !== undefined) {
    process.stdout.write(`${process.env.FAKE_BRIDGE_DELIVERY}\n`)
  }

  setInterval(() => {
    if (inject === undefined) {
      return
    }

    for (const name of readdirSync(inject).filter((one) => one.endsWith(".json")).sort()) {
      const file = path.join(inject, name)

      process.stdout.write(`${readFileSync(file, "utf8").trim()}\n`)
      rmSync(file)
    }
  }, 20)
  await new Promise(() => undefined)
} else if (args !== "hook ask") {
  process.exit(1)
}

appendFileSync(String(process.env.FAKE_BRIDGE_LOG), `${readFileSync(0, "utf8")}\n`)

const mode = process.env.FAKE_BRIDGE_MODE

if (mode === "on") {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASON,
      },
    })}\n`,
  )
  process.exit(0)
}

if (mode === "off") {
  process.exit(0)
}

process.stderr.write(`поддельный мост: незнакомый режим ${String(mode)}\n`)
process.exit(1)
