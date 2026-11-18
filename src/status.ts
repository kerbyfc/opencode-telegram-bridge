// Состояние режима для строки внизу окна OpenCode: короткий вызов тонкого клиента, а не чтение
// состояния моста. Путей внутри состояния службы плагин не знает ни одного, и файлов её не читает:
// имя темы он спрашивает командой.

import { spawn } from "node:child_process"

import { binary, note } from "./bridge.ts"

/** Мост отвечает мгновенно; предел нужен, чтобы зависший вызов не остался навсегда в ожидании. */
const TIMEOUT_MS = 5000

/**
 * Паузы перед повторными дозвонами, миллисекунды. Перезапуск службы — окно без её адреса: старый
 * слушатель снимает файл сокета, новый поднимает его заново (замер 1,0–1,3 с, на медленной сети —
 * 3 с). Один вызов в это окно читает отказ дозвона как «службы моста нет», и опрос строки поднимает
 * ложную тревогу о живой службе. Сумма пауз — 2,7 с: дольше сокет поднимается только на совсем
 * медленной сети, и тогда службы действительно нет.
 */
const BRIDGE_PAUSES_MS = [100, 200, 400, 800, 1200]

/**
 * serviceAbsent — отказ дозвона: адреса нет или за ним никто не слушает, то есть запрос до службы
 * не дошёл, и повтор не отправит его дважды. Отказ по живому соединению не повторяется никогда:
 * его служба уже приняла. Формулировку держит CLI моста (`ErrNoService`), она же уезжает звонящему
 * в потоке ошибок.
 */
function serviceAbsent(err: string): boolean {
  return err.includes("службы моста нет")
}

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
 * строка просто не меняется, а причина уходит в поток ошибок. Отказ дозвона перезванивает паузами
 * `BRIDGE_PAUSES_MS`: окно перезапуска службы пережидается. Промежуточные попытки в журнал не
 * пишутся — пережидённое окно не событие, а не пережидённое назовёт последняя попытка.
 */
export function read(sessionID: string, done: (status: Status | null) => void): void {
  function dial(left: number): void {
    const child = spawn(binary(), ["away", "status", "--session", sessionID, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let out = ""
    let err = ""
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
    child.stderr.on("data", (chunk: string) => {
      err += chunk
    })
    child.on("error", (failure) => {
      note(`away status не запустился: ${String(failure)}`)
      finish(null)
    })
    child.on("close", (code) => {
      if (finished) {
        return
      }

      if (code !== 0 && left > 0 && serviceAbsent(err)) {
        finished = true
        clearTimeout(timer)
        setTimeout(() => dial(left - 1), BRIDGE_PAUSES_MS[BRIDGE_PAUSES_MS.length - left])

        return
      }

      if (err.trim() !== "") {
        note(`away status: ${err.trimEnd()}`)
      }

      finish(parse(code, out))
    })
  }

  dial(BRIDGE_PAUSES_MS.length)
}
