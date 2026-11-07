// Команды режима «не у компьютера» в сессии OpenCode: `/away [имя]` и `/here`. У Claude Code их
// объявляют командой с `!`-строкой, а OpenCode такую строку в команде не исполняет и id своей
// сессии ей не даёт. Поэтому команды регистрирует плагин: id сессии он берёт из самого вызова
// команды и зовёт тот же короткий вызов тонкого клиента, `telegram-bridge away on|off --session <id>`.
//
// Исход владелец видит в самой сессии, как у Claude Code видит вывод команды в терминале: строкой
// моста, которая хода не начинает. В тему не уходит ничего — `mode.on` и `mode.off` тему не пишут.
// Задания модели у команды нет: для модели режим прозрачен, включён он или нет.
//
// Тема всегда носит название чата, поэтому имя после `/away` — новое название самой сессии, а не
// имя темы поверх чата: плагин переименовывает сессию, и тема идёт за ней событием `session.renamed`.

import { spawn } from "node:child_process"

import { binary, reason } from "./bridge.ts"

/**
 * Срок короткого вызова. Включение режима может создать тему вызовом Bot API, поэтому он длиннее,
 * чем у опроса состояния для строки внизу окна.
 */
const TIMEOUT_MS = 30_000

/** Switch — какая из двух команд режима вызвана. */
export type Switch = "on" | "off"

/**
 * args собирает аргументы короткого вызова. Имя — всё, что набрано после команды, одной строкой, как
 * `"$ARGUMENTS"` у команды; пустое имя не передаётся вовсе — тогда служба берёт тему из привязки
 * сессии или из настройки по умолчанию.
 */
export function args(which: Switch, sessionID: string, typed: string): string[] {
  if (which === "off") {
    return ["away", "off", "--session", sessionID]
  }

  const name = typed.trim()

  return name === "" ? ["away", "on", "--session", sessionID] : ["away", "on", name, "--session", sessionID]
}

/**
 * summary собирает строку исхода для владельца. Удача — строка самой подкоманды и подсказка обратной
 * команды; отказ — причина подкоманды, а не догадка: код возврата без строки называется кодом.
 */
export function summary(which: Switch, code: number | null, out: string, err: string): string {
  if (code === 0) {
    const said = out.trim()
    const back = which === "on" ? "выключение — `/here`" : "включение — `/away`"

    return `${said === "" ? (which === "on" ? "режим включён" : "режим снят") : said}; ${back}`
  }

  const reason = err.trim()
  const failed = which === "on" ? "режим не включён" : "режим не снят"

  return `${failed}: ${reason === "" ? `away ${which} кончился кодом ${String(code)}` : reason}`
}

/** Toggled — исход короткого вызова: удался ли он и строка для владельца. */
export type Toggled = { ok: boolean; line: string }

/** toggle зовёт короткий вызов и называет исход строкой для владельца. */
export function toggle(which: Switch, sessionID: string, typed: string): Promise<Toggled> {
  return new Promise<Toggled>((resolve) => {
    const child = spawn(binary(), args(which, sessionID, typed), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let out = ""
    let err = ""
    let finished = false

    const finish = (ok: boolean, line: string): void => {
      if (finished) {
        return
      }

      finished = true
      clearTimeout(timer)
      resolve({ ok, line })
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(false, `${which === "on" ? "режим не включён" : "режим не снят"}: служба не ответила за ${String(TIMEOUT_MS / 1000)} с`)
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
      finish(false, `${which === "on" ? "режим не включён" : "режим не снят"}: мост не запустился: ${String(failure)}`)
    })
    child.on("close", (code) => {
      finish(code === 0, summary(which, code, out, err))
    })
  })
}

/** Rename — переименование сессии OpenCode средством хозяина плагина. */
export type Rename = (sessionID: string, title: string) => Promise<void>

/** Toggle — короткий вызов режима; подменяется в тестах. */
export type Toggle = (which: Switch, sessionID: string, typed: string) => Promise<Toggled>

/**
 * away включает режим командой `/away [имя]`. Непустое имя сначала становится названием сессии, и
 * только потом зовётся `away on`: событие `session.renamed` к этому времени уже несёт службе новое
 * название, и тема не успевает получить прежнее. Переименование не удалось — режим не включается, а
 * причина идёт строкой исхода: иначе тема встала бы под имя, которого владелец не просил.
 */
export async function away(sessionID: string, typed: string, rename: Rename, enable: Toggle = toggle): Promise<Toggled> {
  const name = typed.trim()

  if (name !== "") {
    try {
      await rename(sessionID, name)
    } catch (failure: unknown) {
      return { ok: false, line: `режим не включён: сессия не переименована: ${reason(failure)}` }
    }
  }

  return enable("on", sessionID, typed)
}
