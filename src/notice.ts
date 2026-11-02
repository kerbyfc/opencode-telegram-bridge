// Строки моста в сессии и порядок подачи слова владельца рядом с ними.
//
// Строку моста плагин кладёт синтетическим сообщением без хода (`resume: false`): сервер ставит его
// в ящик сессии доставкой `steer` и до следующего хода оттуда не вынимает. А ход OpenCode 2.1.4
// начинает с того, что вынимает из ящика (`SessionInbox.promote`): есть хоть одна запись `steer` —
// вынимаются только они, запись `queue` остаётся ждать конца хода. Слово владельца доставкой `queue`
// поэтому будит ход, которого само не видит: в ход уходит строка моста, а слово — следующим ходом.
//
// Отсюда правило: пока строка моста этой сессии лежит в ящике, а хода нет, слово подаётся `steer` —
// тогда ход вынимает их вместе и видит оба. В остальное время слово идёт `queue`, как прежде: занятый
// ход оно не подруливает. Строка, которая ещё в пути (вызов сервера не вернулся), считается лежащей:
// слово ждёт её приёма, чтобы встать в ящик после неё, а не обогнать её.
//
// Ход и ящик плагин видит потоком событий, а не состоянием сервера, и порядок «ответ
// `session.synthetic` ↔ события потока» сервер не обещает. Окна, которые от этого остаются, и что
// в них видит владелец:
//
// - ход начался на сервере (ввод в TUI, перезагрузка плагина посреди хода), а события начала плагин
//   ещё не видел — слово уходит `steer` в идущий ход и попадает в него на ближайшем шаге, а не после
//   конца хода;
// - событие вынимания пришло раньше ответа `session.synthetic` — id строки лежит у плагина до конца
//   следующего хода, и слово на простое идёт `steer` в ящик без строки; на простое это то же, что
//   `queue`: ход вынимает слово одно;
// - ход кончился на сервере, а события конца плагин ещё не видел, и строка, сказанная в этот миг,
//   снимется концом хода, хотя лежит, — слово после неё пойдёт `queue`, и ход его увидит только
//   следующим ходом. Окно — время доставки одного события.

/** Delivery — доставка слова владельца: так её называет `session.prompt`. */
export type Delivery = "steer" | "queue"

/**
 * delivery выбирает доставку слова: строка моста лежит в ящике, а хода нет — `steer`, иначе `queue`.
 * Идущий ход вынимает `steer` сам на следующем шаге, и слово `steer` его подрулило бы, поэтому при
 * ходе слово остаётся `queue`.
 */
export function delivery(lying: boolean, running: boolean): Delivery {
  return lying && !running ? "steer" : "queue"
}

/**
 * Notices — строки моста и ход по сессиям: какие строки ещё в пути, какие лежат в ящике сервера и
 * идёт ли ход. Id записи ящика называет ответ `session.synthetic`, вынимание — событие
 * `session.inbox.delivered`, границы хода — события исполнения.
 */
export class Notices {
  /** Цепочка строк сессии в пути: слово ждёт её конца. */
  private readonly chains = new Map<string, Promise<void>>()
  /** Сколько строк сессии ещё в пути. */
  private readonly flying = new Map<string, number>()
  /**
   * Id записей ящика со строками моста, которых ход ещё не вынул, и застал ли их ход: строку,
   * лежавшую при ходе, ход вынимает до своего конца, а лёгшую после конца — нет.
   */
  private readonly lying = new Map<string, Map<string, boolean>>()
  /** Сессии, у которых идёт ход. */
  private readonly running = new Set<string>()

  /**
   * carry ставит строку сессии в путь: `send` кладёт её в ящик и отдаёт id записи; не легла —
   * `undefined`. Пока строка в пути, `settled` сессии её ждёт.
   */
  carry(sessionID: string, send: () => Promise<string | undefined>): Promise<void> {
    this.flying.set(sessionID, (this.flying.get(sessionID) ?? 0) + 1)

    const done = (async () => {
      try {
        const id = await send()
        if (id !== undefined) {
          this.ids(sessionID).set(id, this.running.has(sessionID))
        }
      } finally {
        const left = (this.flying.get(sessionID) ?? 1) - 1

        if (left <= 0) {
          this.flying.delete(sessionID)
        } else {
          this.flying.set(sessionID, left)
        }
      }
    })()

    // Отказ строки виден тому, кто её нёс (`done`); слово он не держит и подачу не роняет.
    const chain = (this.chains.get(sessionID) ?? Promise.resolve()).then(() => done).catch(() => undefined)

    this.chains.set(sessionID, chain)

    return done
  }

  /** settled ждёт, пока у сессии не останется строк в пути. */
  async settled(sessionID: string): Promise<void> {
    for (;;) {
      const chain = this.chains.get(sessionID)
      if (chain === undefined) {
        return
      }

      await chain

      if (this.chains.get(sessionID) === chain) {
        this.chains.delete(sessionID)

        return
      }
    }
  }

  /** waiting отвечает, лежит ли строка моста сессии в ящике или ещё в пути. */
  waiting(sessionID: string): boolean {
    return (this.flying.get(sessionID) ?? 0) > 0 || (this.lying.get(sessionID)?.size ?? 0) > 0
  }

  /** busy отвечает, идёт ли у сессии ход. */
  busy(sessionID: string): boolean {
    return this.running.has(sessionID)
  }

  /** choose выбирает доставку слова сессии по тому, что лежит в ящике и идёт ли ход. */
  choose(sessionID: string): Delivery {
    return delivery(this.waiting(sessionID), this.busy(sessionID))
  }

  /** delivered снимает запись, которую ход вынул из ящика или владелец отменил. */
  delivered(sessionID: string, inboxID: string): void {
    this.lying.get(sessionID)?.delete(inboxID)
  }

  /** started отмечает начало хода: всё, что лежит в ящике, ход вынет до своего конца. */
  started(sessionID: string): void {
    this.running.add(sessionID)

    const ids = this.lying.get(sessionID)
    for (const id of ids?.keys() ?? []) {
      ids?.set(id, true)
    }
  }

  /**
   * ended отмечает конец хода и снимает строки, которые ход застал: ход не кончается, пока в ящике
   * есть запись `steer`, — сервер вынимает её и идёт дальше (`SessionRunner.drain`). Событие
   * вынимания могло пройти мимо (поток событий переподнимался) — без этого снятия слово шло бы
   * `steer` вечно. Строку, лёгшую на простое, конец хода не снимает: её ход ещё не вынимал.
   */
  ended(sessionID: string): void {
    this.running.delete(sessionID)

    const ids = this.lying.get(sessionID)
    for (const [id, seen] of ids ?? []) {
      if (seen) {
        ids?.delete(id)
      }
    }
  }

  /** forget забывает сессию целиком: её удалили. */
  forget(sessionID: string): void {
    this.lying.delete(sessionID)
    this.running.delete(sessionID)
    this.chains.delete(sessionID)
    this.flying.delete(sessionID)
  }

  private ids(sessionID: string): Map<string, boolean> {
    let ids = this.lying.get(sessionID)
    if (ids === undefined) {
      ids = new Map<string, boolean>()
      this.lying.set(sessionID, ids)
    }

    return ids
  }
}
