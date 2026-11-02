// Порядок подачи слова владельца рядом со строками моста (`src/notice.ts`). Ход OpenCode 2.1.4
// вынимает из ящика сессии сначала записи `steer`, и при них запись `queue` ждёт конца хода: строка
// моста лежит `steer`, поэтому слово рядом с ней обязано идти `steer`, а встать в ящик — после неё.
//
// Запуск: `npm test` в корне репозитория.

import assert from "node:assert/strict"
import { test } from "node:test"

import { taken } from "../src/index.ts"
import { delivery, Notices } from "../src/notice.ts"

test("доставка слова: строка моста лежит, а хода нет, — steer; иначе queue", () => {
  assert.equal(delivery(true, false), "steer")
  assert.equal(delivery(true, true), "queue", "идущий ход слово не подруливает")
  assert.equal(delivery(false, false), "queue")
  assert.equal(delivery(false, true), "queue")
})

test("слово ждёт строку моста в пути и встаёт в ящик после неё", async () => {
  const notices = new Notices()
  const order: string[] = []
  let admit: (id: string | undefined) => void = () => undefined

  const carried = notices.carry("ses", async () => {
    const id = await new Promise<string | undefined>((resolve) => {
      admit = resolve
    })

    order.push(`строка ${String(id)}`)

    return id
  })

  assert.equal(notices.waiting("ses"), true, "строка в пути считается лежащей")

  const word = (async () => {
    await notices.settled("ses")
    order.push(`слово ${delivery(notices.waiting("ses"), false)}`)
  })()

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, [], "слово обогнало строку в пути")

  admit("msg_1")
  await carried
  await word

  assert.deepEqual(order, ["строка msg_1", "слово steer"])
})

test("вынутая ходом строка больше не лежит, и слово снова идёт queue", async () => {
  const notices = new Notices()

  await notices.carry("ses", async () => "msg_1")
  await notices.carry("ses", async () => "msg_2")
  assert.equal(notices.waiting("ses"), true)

  notices.delivered("ses", "msg_1")
  assert.equal(notices.waiting("ses"), true, "вторая строка ещё лежит")

  notices.delivered("ses", "msg_2")
  assert.equal(notices.waiting("ses"), false)
  assert.equal(delivery(notices.waiting("ses"), false), "queue")
})

test("конец хода снимает строки, которые ход застал, а лёгшую на простое — нет", async () => {
  const notices = new Notices()

  await notices.carry("ses", async () => "msg_1")
  await notices.carry("другая", async () => "msg_9")
  notices.started("ses")
  assert.equal(notices.choose("ses"), "queue", "при ходе слово идёт queue")
  notices.ended("ses")

  assert.equal(notices.waiting("ses"), false, "строку, лежавшую при ходе, ход вынул")
  assert.equal(notices.waiting("другая"), true, "конец хода чужой сессии её строк не снимает")

  await notices.carry("ses", async () => "msg_2")
  notices.ended("ses")
  assert.equal(notices.choose("ses"), "steer", "конец хода без начала снял строку, лёгшую на простое")

  notices.started("ses")
  await notices.carry("ses", async () => "msg_3")
  notices.ended("ses")
  assert.equal(notices.waiting("ses"), false, "строка, лёгшая при ходе, снимается его концом")

  await notices.carry("ses", async () => undefined)
  assert.equal(notices.waiting("ses"), false, "строка, которую сервер не принял, в ящике не лежит")
})

test("удалённая сессия забывается целиком: строки, ход и цепочка", async () => {
  const notices = new Notices()

  await notices.carry("ses", async () => "msg_1")
  notices.started("ses")
  notices.forget("ses")

  assert.equal(notices.waiting("ses"), false)
  assert.equal(notices.busy("ses"), false)
  await notices.settled("ses")
})

test("строка, упавшая в пути, слово не держит", async () => {
  const notices = new Notices()

  await assert.rejects(notices.carry("ses", async () => Promise.reject(new Error("сервер упал"))))
  await notices.settled("ses")

  assert.equal(notices.waiting("ses"), false)
})

test("запись ящика называют только события вынимания и отмены", () => {
  assert.equal(taken("session.inbox.delivered", { sessionID: "ses", inboxID: "msg_1" }), "msg_1")
  assert.equal(taken("session.inbox.cancelled", { sessionID: "ses", inboxID: "msg_2" }), "msg_2")
  assert.equal(taken("session.inbox.enqueued", { sessionID: "ses", inboxID: "msg_3" }), undefined)
  assert.equal(taken("session.inbox.delivered", { sessionID: "ses" }), undefined)
  assert.equal(taken("session.inbox.delivered", undefined), undefined)
})
