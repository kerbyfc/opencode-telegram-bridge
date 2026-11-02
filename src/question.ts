// Вопрос с вариантами в режиме «не у компьютера»: инструмент OpenCode `question` уходит в тему тем же
// входом, что вопрос Claude Code, — подкомандой тонкого клиента `telegram-bridge hook ask`. Нагрузку
// она читает со стандартного входа, сама спрашивает у службы режим сессии и отправляет каждый вопрос
// `question.ask`; плагин только перекладывает вход инструмента в её нагрузку и читает её решение.
// Своего решения «в теме или в диалоге» у плагина нет: его принимает подкоманда, одна на оба клиента.
//
// Ответа вход не ждёт ни у одного клиента: владелец ответит сообщением, и оно придёт сессии новым
// ходом обычной доставкой. Поэтому вызов инструмента, ушедший в тему, кончается отказом с причиной —
// у Claude Code это решение `deny` хука, здесь — ошибка обработчика `tool.execute.before`, которую
// сервер отдаёт модели ошибкой инструмента с тем же текстом.

import { spawn } from "node:child_process"

import { binary, note } from "./bridge.ts"

/** Имя инструмента вопросов у сервера OpenCode. */
export const QUESTION_TOOL = "question"

/**
 * Срок подкоманды. Свой срок у неё 100 с на всю нагрузку (`hookBudget`), и этот обязан быть длиннее
 * с запасом на запуск — так же, как строка хука у Claude Code (`"timeout": 120`).
 */
const TIMEOUT_MS = 120_000

/**
 * Код возврата подкоманды хука «вызов инструмента отбирается, причина — в потоке ошибок». Значение
 * задано семантикой хуков Claude Code, которую подкоманда держит: любой другой код — некритичная
 * ошибка, после которой вызов идёт своим чередом.
 */
const BLOCKED = 2

/** Verdict — что делать с вызовом инструмента вопросов. */
export type Verdict =
  /** dialog — вопрос остаётся диалогом OpenCode: режим снят, службы нет или вход подкоманды негодный. */
  | { act: "dialog"; detail: string }
  /** refuse — вызов инструмента не открывается: причину получит модель ошибкой инструмента. */
  | { act: "refuse"; reason: string }

/** decision — решение подкоманды на стандартном выходе: те же поля, что читает Claude Code. */
type decision = {
  hookSpecificOutput?: {
    permissionDecision?: unknown
    permissionDecisionReason?: unknown
  }
}

/**
 * payload собирает нагрузку подкоманды из входа инструмента: та же форма, что кладёт хук Claude Code
 * (`session_id`, `tool_input.questions`). Вопрос OpenCode называет «можно несколько» полем `multiple`,
 * а подкоманда — `multiSelect`; остальные поля вопроса совпадают по имени и едут как есть. Вход не
 * той формы не правится: разбирает и отвергает его подкоманда, у которой на этот случай своё
 * правило — при включённом режиме это отказ, а не диалог в пустоту.
 */
export function payload(sessionID: string, input: unknown): string {
  return JSON.stringify({ session_id: sessionID, tool_input: renamed(input) })
}

/** renamed переименовывает `multiple` в `multiSelect` у вопросов входа, ничего больше не трогая. */
function renamed(input: unknown): unknown {
  if (typeof input !== "object" || input === null) {
    return input
  }

  const questions = (input as { readonly questions?: unknown }).questions
  if (!Array.isArray(questions)) {
    return input
  }

  return {
    ...input,
    questions: questions.map((question: unknown) => {
      if (typeof question !== "object" || question === null || !("multiple" in question)) {
        return question
      }

      const { multiple, ...rest } = question as { readonly multiple?: unknown }

      return { ...rest, multiSelect: multiple }
    }),
  }
}

/**
 * verdict читает исход подкоманды по правилам хука Claude Code, которые она держит:
 * - код `2` — отказ, причина в потоке ошибок;
 * - код `0` без вывода — вопрос остаётся диалогом, а строка потока ошибок называет почему;
 * - код `0` с решением `deny` — вопрос в теме, причина решения уходит модели;
 * - код `0` с выводом, который решением не читается, — отказ: ушёл ли вопрос в тему, неизвестно, и
 *   диалог мог бы прислать его владельцу второй раз, а молчание спрятало бы поломку моста;
 * - любой другой код, сигнал или незапуск — некритичная ошибка хука: вопрос остаётся диалогом.
 */
export function verdict(code: number | null, out: string, err: string): Verdict {
  const said = err.trim()

  if (code === BLOCKED) {
    return { act: "refuse", reason: said === "" ? "мост Telegram отказал без причины" : said }
  }

  if (code !== 0) {
    return { act: "dialog", detail: `hook ask кончился кодом ${String(code)}${said === "" ? "" : `: ${said}`}` }
  }

  const printed = out.trim()
  if (printed === "") {
    return { act: "dialog", detail: said }
  }

  let parsed: decision

  try {
    parsed = JSON.parse(printed) as decision
  } catch {
    return { act: "refuse", reason: unread(printed) }
  }

  const outcome = parsed.hookSpecificOutput
  const reason = outcome?.permissionDecisionReason

  if (outcome?.permissionDecision !== "deny" || typeof reason !== "string" || reason === "") {
    return { act: "refuse", reason: unread(printed) }
  }

  return { act: "refuse", reason }
}

/** unread называет вывод подкоманды, которого решение не читает. */
function unread(printed: string): string {
  return (
    `мост Telegram ответил на вопрос непонятно (${printed}): ушёл ли вопрос в тему, неизвестно — ` +
    "задай его текстом хода"
  )
}

/**
 * ask отдаёт вопрос подкоманде и называет решение. Строка потока ошибок подкоманды уходит в поток
 * ошибок сервера и тогда, когда вопрос остаётся диалогом: тихих «в тему не ушло» здесь нет.
 */
export function ask(sessionID: string, input: unknown): Promise<Verdict> {
  return new Promise<Verdict>((resolve) => {
    const child = spawn(binary(), ["hook", "ask"], { stdio: ["pipe", "pipe", "pipe"] })

    let out = ""
    let err = ""
    let finished = false

    const finish = (result: Verdict): void => {
      if (finished) {
        return
      }

      finished = true
      clearTimeout(timer)

      if (result.act === "dialog" && result.detail !== "") {
        note(`${sessionID}: вопрос остался диалогом: ${result.detail}`)
      }

      resolve(result)
    }

    // Срок вышел — подкоманда гасится, и это некритичная ошибка хука, как у Claude Code, чей
    // оборванный хук диалог открывает. Сама подкоманда в свой срок отвечает отказом с кодом `2`.
    const timer = setTimeout(() => {
      child.kill()
      finish({ act: "dialog", detail: `hook ask не ответил за ${String(TIMEOUT_MS / 1000)} с` })
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
      finish({ act: "dialog", detail: `hook ask не запустился: ${String(failure)}` })
    })
    child.on("close", (code) => {
      finish(verdict(code, out, err))
    })

    // Подкоманда, умершая до чтения входа, рвёт трубу: это та же смерть, исход назовёт `close`.
    child.stdin.on("error", () => undefined)
    child.stdin.end(payload(sessionID, input))
  })
}
