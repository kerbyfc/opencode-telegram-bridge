// Разводка доставки по виду — без вызовов клиента, чтобы её проверял тест, а не только глаз:
// решение «слово владельца, команда или отказ» принимается здесь, а исполняет его плагин.

import type { Linked, Taken } from "./link.ts"

/** Plan — что плагину делать с доставкой. */
export type Plan =
  /** word — слово владельца: подать новым ходом текст с провенансом первыми строками. */
  | { act: "word"; text: string }
  /** command — команда из темы: исполнить вызовом, равным набору команды владельцем. */
  | { act: "command"; name: string; args: string }
  /** refuse — подавать нечего: слово владельца остаётся придержанным, причина — в журнал службы. */
  | { act: "refuse"; detail: string }

/** head отрезает у строки команды имя: всё после первого пробела — её аргументы. */
export function head(line: string): { name: string; args: string } {
  const body = line.trim().replace(/^\/+/, "")
  const gap = body.search(/\s/)

  return gap === -1
    ? { name: body, args: "" }
    : { name: body.slice(0, gap), args: body.slice(gap + 1).trim() }
}

/**
 * plan разводит доставку по виду. Незнакомый вид в сессию не подаётся: молча проглотить доставку
 * нельзя — у неё есть `delivery_id`, и неподтверждённая она остаётся в ящике.
 */
export function plan(event: Linked): Plan {
  if (event.kind === "owner-message") {
    const text = event.text ?? ""
    const provenance = event.provenance ?? ""

    if (text === "" || provenance === "") {
      return { act: "refuse", detail: "доставка без текста или без провенанса" }
    }

    return { act: "word", text: `${provenance}\n\n${text}` }
  }

  if (event.kind === "client-command") {
    const { name, args } = head(event.text ?? "")

    if (name === "") {
      return { act: "refuse", detail: "команда без имени" }
    }

    return { act: "command", name, args }
  }

  return { act: "refuse", detail: `доставка незнакомого вида ${event.kind ?? "?"}` }
}

/** rejected — придержанное слово: подача не разрешилась, и причина уходит в журнал службы. */
export function rejected(detail: string): Taken {
  return { outcome: "rejected", detail }
}

/** accepted — честь: подача разрешилась. */
export const accepted: Taken = { outcome: "accepted", detail: "" }
