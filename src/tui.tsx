/** @jsxImportSource @opentui/solid */
// Строка внизу окна OpenCode с именем темы — единственное, что у OpenCode своё, и это требование
// владельца. Рисует её сам OpenCode, а состояние берёт запросом `mode.status` у моста, а не
// чтением его состояния: жёлтым активная тема («не у компьютера»), приглушённо — привязка без
// режима.
//
// Событий о смене режима у протокола нет вовсе (пуша в нём нет), поэтому состояние опрашивается.
// Опрашиваются только сессии, чью строку OpenCode рисовал недавно: иначе список растёт вместе с
// числом открытых за жизнь окна сессий, и опрос спрашивает мост про каждую.

import type { Plugin } from "@opencode/plugin/tui"

import { owned, pluginID, pluginRoot } from "./bridge.ts"
import { read, type Status } from "./status.ts"

/** Как часто спрашивается состояние режима. */
const REFRESH_MS = 5000

/** Сколько сессия считается показанной после последней отрисовки её строки. */
const SEEN_MS = 30_000

/**
 * state — состояние режима по сессиям. Оно и только оно живёт в хранилище: строку рисует оно, и
 * перезагрузка плагина её не теряет. Учёт отрисовок и запросов в полёте реактивным быть не должен —
 * писать его из отрисовки значило бы править состояние во время чтения.
 */
type state = {
  sessions: Record<string, Status>
}

export default {
  // Id копии уникален на дерево, как у серверной половины: копия каталога есть в каждом worktree.
  id: pluginID("opencode-telegram-bridge.tui", pluginRoot(import.meta.url)),
  setup: (context) => {
    const own = pluginRoot(import.meta.url)
    const [state, setState] = context.storage.memory<state>("opencode-telegram-bridge", {
      initial: { sessions: {} },
    })

    /** Запросы в полёте: второй запрос той же сессии не нужен. */
    const pending = new Set<string>()
    /** Когда строку сессии рисовали последний раз. */
    const seen = new Map<string, number>()

    /**
     * mine — сессия этой копии: в одном окне открыты сессии из разных деревьев, у каждого дерева
     * своя копия плагина, и строку рисует только она — иначе на сессию приходилось бы по строке с
     * каждой открытой копии. Копия, поставленная из Git-адреса, одна на сервер и рисует все сессии.
     */
    function mine(sessionID: string): boolean {
      const directory = context.data.session.get(sessionID)?.location?.directory

      return directory !== undefined && owned(own, directory)
    }

    function refresh(sessionID: string): void {
      if (pending.has(sessionID) || !mine(sessionID)) {
        return
      }

      pending.add(sessionID)
      read(sessionID, (status) => {
        pending.delete(sessionID)

        // Мост не ответил — прежняя строка остаётся: сломанная связь не читается как снятый режим.
        if (status === null) {
          return
        }

        setState((draft) => {
          draft.sessions[sessionID] = status
        })
      })
    }

    /** mark отмечает, что строку этой сессии рисовали, и спрашивает состояние у первого раза. */
    function mark(sessionID: string): void {
      const known = seen.has(sessionID)

      seen.set(sessionID, Date.now())

      if (!known) {
        refresh(sessionID)
      }
    }

    /** forget снимает сессию с опроса и убирает её строку. */
    function forget(sessionID: string): void {
      seen.delete(sessionID)

      if (state.sessions[sessionID] === undefined) {
        return
      }

      setState((draft) => {
        delete draft.sessions[sessionID]
      })
    }

    const timer = setInterval(() => {
      const edge = Date.now() - SEEN_MS

      for (const [sessionID, at] of [...seen]) {
        // Сессия переехала в другое дерево — её строку рисует копия того дерева.
        if (at >= edge && mine(sessionID)) {
          refresh(sessionID)

          continue
        }

        // Строку этой сессии давно не рисовали или она уже не наша: спрашивать про неё мост
        // больше незачем.
        forget(sessionID)
      }
    }, REFRESH_MS)

    const untrack = context.data.on("session.deleted", (event) => {
      forget(event.data.sessionID)
    })

    const slot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        if (input.sessionID === undefined || !mine(input.sessionID)) {
          return null
        }

        mark(input.sessionID)

        const status = state.sessions[input.sessionID]
        if (status === undefined || status.topic === null) {
          return null
        }

        return (
          <text fg={status.away ? context.theme.text.feedback.warning.base : context.theme.text.muted}>
            TG: {status.topic}
          </text>
        )
      },
    })

    return () => {
      clearInterval(timer)
      untrack()
      slot()
    }
  },
} satisfies Plugin.Definition
