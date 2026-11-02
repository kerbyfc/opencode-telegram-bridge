// Состояние режима для строки внизу окна OpenCode: короткий вызов тонкого клиента, а не чтение
// состояния моста. Путей внутри состояния службы плагин не знает ни одного, и файлов её не читает:
// имя темы он спрашивает командой.

import { spawn } from "node:child_process"

import { binary, note } from "./bridge.ts"

/** Мост отвечает мгновенно; предел нужен, чтобы зависший вызов не остался навсегда в ожидании. */
const TIMEOUT_MS = 5000

/** Status — состояние режима сессии, как его называет `mode.status`. */
export type Status = {
  /** away — включён ли режим «не у компьютера». */
  away: boolean
  /** topic — имя темы сессии; привязка остаётся и после снятия режима. */
  topic: string | null
}

/** awayReply — машинный ответ `telegram-bridge away status --json`: имена полей — как в кадрах. */
type awayReply = {
  mode?: string
  topic_name?: string
}

/**
 * parse разбирает ответ короткого вызова. Отказ не читается как «режим выключен»: ненулевой код,
 * не-JSON и ответ без режима дают `null`, то есть «состояние неизвестно», и строка внизу окна
 * остаётся прежней. Причина при этом названа строкой — тихого успеха на ошибке нет.
 */
export function parse(code: number | null, out: string): Status | null {
  if (code !== 0) {
    note(`away status кончился кодом ${String(code)}`)

    return null
  }

  let parsed: awayReply

  try {
    parsed = JSON.parse(out) as awayReply
  } catch (failure) {
    note(`away status вернул не JSON (${out.trim()}): ${String(failure)}`)

    return null
  }

  if (parsed.mode !== "on" && parsed.mode !== "off") {
    note(`away status вернул ответ без режима (${out.trim()})`)

    return null
  }

  const topic = parsed.topic_name

  return {
    away: parsed.mode === "on",
    topic: typeof topic === "string" && topic !== "" ? topic : null,
  }
}

/**
 * read спрашивает состояние режима сессии. Рендер он не блокирует: ответ приходит колбэком, `null`
 * — мост не ответил или ответ не разобран. Отказ при этом не читается как «режим выключен»:
 * строка просто не меняется, а причина уходит в поток ошибок.
 */
export function read(sessionID: string, done: (status: Status | null) => void): void {
  const child = spawn(binary(), ["away", "status", "--session", sessionID, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  let out = ""
  let finished = false

  const finish = (status: Status | null): void => {
    if (finished) {
      return
    }

    finished = true
    clearTimeout(timer)
    done(status)
  }

  const timer = setTimeout(() => {
    child.kill()
    finish(null)
  }, TIMEOUT_MS)

  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    out += chunk
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => note(`away status: ${chunk.trimEnd()}`))
  child.on("error", (failure) => {
    note(`away status не запустился: ${String(failure)}`)
    finish(null)
  })
  child.on("close", (code) => {
    if (finished) {
      return
    }

    finish(parse(code, out))
  })
}
