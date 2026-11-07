// Цикл событий плагина на поддельном клиенте OpenCode: настоящий `setup` читает поток событий
// сервера, а клиент и бинарь моста подменены. Чистые куски (`plugin.test.ts`) `setup` не зовут,
// поэтому цикл — разбор события, границы хода, реплика, снятие сессии — проверяется здесь: он
// обязан дочитать поток до конца, а не оборваться на каком-то виде события.
//
// Бинарь моста указан в никуда: подкоманда `link` не поднимается, мост владельца и его служба
// тестом не трогаются. Соединение сессии при этом гаснет само, плагин говорит об этом строкой в
// поток ошибок, и тест эти строки собирает: по `снято с учёта` он знает, что хвост соединения
// кончился, по `оборвался` — что цикл упал.
//
// Запуск: `npm test` в корне репозитория.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import plugin from "../src/index.ts"

/** Контекст, который сервер OpenCode отдаёт плагину. */
type Host = Parameters<typeof plugin.setup>[0]

/** Событие потока в том виде, в каком его отдаёт сервер: вид и нагрузка с id сессии. */
type Sent = {
  readonly type: string
  readonly data?: { readonly sessionID: string; readonly text?: string; readonly title?: string }
}

/** Сессия папки плагина и сессия чужой папки: вторую плагин держать не должен. */
const OWN = "ses-своя"
const OTHER = "ses-чужая"

test("цикл событий читает поток до конца и переживает любой вид события", { timeout: 15_000 }, async () => {
  const here = mkdtempSync(path.join(tmpdir(), "dmtg-setup-"))
  const now = Date.now()
  const events: Sent[] = [
    { type: "server.connected" },
    { type: "session.created", data: { sessionID: OWN } },
    { type: "session.execution.started", data: { sessionID: OWN } },
    { type: "session.text.ended", data: { sessionID: OWN, text: "читаю диффы" } },
    { type: "session.text.ended", data: { sessionID: OTHER, text: "реплика чужой папки" } },
    { type: "session.execution.succeeded", data: { sessionID: OWN } },
    { type: "session.moved", data: { sessionID: OTHER } },
    { type: "session.deleted", data: { sessionID: OTHER } },
  ]

  // Сколько событий плагин взял из потока и когда поток закрылся: `finally` отрабатывает и после
  // последнего события, и когда читающий цикл упал и закрыл поток досрочно.
  let pulled = 0
  let drain: () => void = () => undefined
  const drained = new Promise<void>((resolve) => {
    drain = resolve
  })

  async function* stream(): AsyncGenerator<Sent> {
    try {
      for (const event of events) {
        pulled += 1

        yield event
      }
    } finally {
      drain()
    }
  }

  // Только то, чем пользуются проверяемые события: подача слова и команды сюда не доходят.
  const client = {
    location: { directory: here },
    session: {
      list: async () => ({ data: [], cursor: { next: null } }),
      get: async (query: { sessionID: string }) => ({
        location: { directory: query.sessionID === OWN ? here : path.join(here, "чужая-папка") },
        time: { created: now, updated: now },
      }),
      synthetic: async () => ({ id: "msg_0" }),
    },
    event: { subscribe: () => stream() },
    tool: { hook: async () => ({ dispose: async () => undefined }) },
    command: { transform: async () => ({ dispose: async () => undefined }) },
  }

  // Строки плагина о жизни соединений уходят в поток ошибок процесса: собираем их, а не печатаем.
  const lines: string[] = []
  let gone: () => void = () => undefined
  const ended = new Promise<void>((resolve) => {
    gone = resolve
  })
  const original = process.stderr.write
  const named = process.env.DM_TELEGRAM_BRIDGE

  const collect = (chunk: string | Uint8Array): boolean => {
    const line = String(chunk)

    lines.push(line)
    if (line.includes("снято с учёта")) {
      gone()
    }

    return true
  }

  try {
    process.env.DM_TELEGRAM_BRIDGE = path.join(here, "нет-такого-моста")
    process.stderr.write = collect as typeof process.stderr.write

    const stop = await plugin.setup(client as unknown as Host)

    try {
      await drained
      await ended
    } finally {
      stop()
    }

    const dropped = lines.find((line) => line.includes("поток событий оборвался"))

    assert.equal(dropped, undefined, `цикл событий упал: ${dropped ?? ""}`)
    assert.equal(pulled, events.length, "плагин прочитал не весь поток")
  } finally {
    process.stderr.write = original

    if (named === undefined) {
      delete process.env.DM_TELEGRAM_BRIDGE
    } else {
      process.env.DM_TELEGRAM_BRIDGE = named
    }

    rmSync(here, { recursive: true, force: true })
  }
})

/** Поддельный мост: подкоманда `hook ask` отвечает по режиму из `FAKE_BRIDGE_MODE`. */
const FAKE_BRIDGE = path.resolve(import.meta.dirname, "fake-bridge.mjs")

/** Причина решения `deny` у поддельного моста. */
const ASKED = "Вопрос отправлен владельцу в тему Telegram"

/** Вызов инструмента, как его отдаёт обработчику `tool.execute.before` сервер. */
type Call = {
  tool: string
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  input: unknown
}

/** Переменные окружения, которые тест вопроса ставит и обязан вернуть. */
const NAMES = [
  "DM_TELEGRAM_BRIDGE",
  "FAKE_BRIDGE_LOG",
  "FAKE_BRIDGE_MODE",
  "FAKE_BRIDGE_AWAY_DELAY_MS",
  "FAKE_BRIDGE_DELIVERY",
  "FAKE_BRIDGE_INJECT",
  "FAKE_BRIDGE_FRONT",
] as const

// Поддельный мост — сценарий Node с первой строкой `#!`: без оболочки его запускает только POSIX.
test(
  "вопрос в режиме уходит службе вопросом, вне режима — остаётся диалогом",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-ask-"))
    const log = path.join(here, "asked.jsonl")
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))

    let before: ((call: Call) => Promise<void> | void) | undefined

    // Поток событий пуст: соединений тест не поднимает, проверяется только обработчик вызова.
    async function* stream(): AsyncGenerator<never> {}

    const client = {
      location: { directory: here },
      session: { list: async () => ({ data: [], cursor: { next: null } }) },
      event: { subscribe: () => stream() },
      tool: {
        hook: async (name: string, callback: (call: Call) => Promise<void> | void) => {
          if (name === "execute.before") {
            before = callback
          }

          return { dispose: async () => undefined }
        },
      },
      command: { transform: async () => ({ dispose: async () => undefined }) },
    }

    const original = process.stderr.write

    const call = (id: string, tool = "question"): Call => ({
      tool,
      sessionID: "ses_opencode",
      agent: "build",
      messageID: "msg-1",
      id,
      input: {
        questions: [
          {
            header: "Ветка",
            question: "Куда целить MR?",
            multiple: true,
            options: [
              { label: "most-telegram-na-go", description: "ветка проекта" },
              { label: "master", description: "основная" },
            ],
          },
        ],
      },
    })

    try {
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = log
      // Строки плагина о жизни соединений тесту не нужны: глушим, чтобы не засорять вывод прогона.
      process.stderr.write = (() => true) as typeof process.stderr.write

      const stop = await plugin.setup(client as unknown as Host)

      try {
        assert.notEqual(before, undefined, "обработчик tool.execute.before не поставлен")
        const hook = before as (call: Call) => Promise<void> | void

        // Режим включён: вызов отбирается ошибкой с причиной подкоманды — её получит модель.
        process.env.FAKE_BRIDGE_MODE = "on"
        await assert.rejects(async () => hook(call("call-on")), { message: ASKED })

        // Тот же вызов второй раз — другой экземпляр плагина: подкоманда его не получает.
        await hook(call("call-on"))

        // Режим снят: обработчик ничего не меняет, диалог открывает сам OpenCode.
        process.env.FAKE_BRIDGE_MODE = "off"
        await hook(call("call-off"))

        // Чужой инструмент подкоманде не отдаётся вовсе.
        await hook(call("call-bash", "bash"))
      } finally {
        stop()
      }

      const asked = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown)

      const sent = {
        session_id: "ses_opencode",
        tool_input: {
          questions: [
            {
              header: "Ветка",
              question: "Куда целить MR?",
              options: [
                { label: "most-telegram-na-go", description: "ветка проекта" },
                { label: "master", description: "основная" },
              ],
              multiSelect: true,
            },
          ],
        },
      }

      assert.deepEqual(asked, [sent, sent], "подкоманда получила не те вызовы или не ту нагрузку")
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

/** Вызов команды, как его отдаёт сервер: сессия и набранный после имени текст. */
type Invocation = { readonly sessionID: string; readonly prompt: { readonly text: string } }

/** Команда, как плагин её регистрирует. */
type Registered = { readonly name: string; readonly execute: (call: Invocation) => Promise<void> }

test(
  "/away и /here переключают режим этой сессии OpenCode и говорят исход в ней же",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-mode-"))
    const log = path.join(here, "mode.jsonl")
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
    const added = new Map<string, Registered>()
    const said: Array<{ sessionID: string; text: string; description: string; resume: boolean }> = []
    const renamed: Array<{ sessionID: string; title?: string }> = []

    async function* stream(): AsyncGenerator<never> {}

    const client = {
      location: { directory: here },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        update: async (input: { sessionID: string; title?: string }) => {
          renamed.push({ sessionID: input.sessionID, title: input.title })
        },
        synthetic: async (input: { sessionID: string; text: string; description: string; resume: boolean }) => {
          said.push({
            sessionID: input.sessionID,
            text: input.text,
            description: input.description,
            resume: input.resume,
          })

          return { id: `msg_${String(said.length)}` }
        },
      },
      event: { subscribe: () => stream() },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      command: {
        transform: async (callback: (editor: { add: (one: Registered) => void }) => void) => {
          callback({ add: (one: Registered) => added.set(one.name, one) })

          return { dispose: async () => undefined }
        },
      },
    }

    const original = process.stderr.write

    // Строка исхода уходит синтетическим сообщением без ожидания: ждём, пока оно придёт.
    const spoken = async (count: number): Promise<void> => {
      for (let tick = 0; said.length < count && tick < 100; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    try {
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = log
      process.env.FAKE_BRIDGE_MODE = "on"
      process.stderr.write = (() => true) as typeof process.stderr.write

      const stop = await plugin.setup(client as unknown as Host)

      try {
        assert.deepEqual([...added.keys()].sort(), ["away", "here"], "плагин регистрирует ровно две команды режима")

        await added.get("away")?.execute({ sessionID: "ses_one", prompt: { text: "  проба темы  " } })
        await added.get("away")?.execute({ sessionID: "ses_two", prompt: { text: "" } })
        await added.get("here")?.execute({ sessionID: "ses_one", prompt: { text: "" } })

        process.env.FAKE_BRIDGE_MODE = "refuse"
        await added.get("away")?.execute({ sessionID: "ses_one", prompt: { text: "" } })

        await spoken(4)
      } finally {
        stop()
      }

      const argv = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)

      assert.deepEqual(renamed, [{ sessionID: "ses_one", title: "проба темы" }], "имя после /away — название сессии")
      assert.deepEqual(argv, [
        ["away", "on", "проба темы", "--session", "ses_one"],
        ["away", "on", "--session", "ses_two"],
        ["away", "off", "--session", "ses_one"],
        ["away", "on", "--session", "ses_one"],
      ])

      // Окно OpenCode показывает синтетическое сообщение одной строкой описания: исход идёт и им,
      // и текстом, а другого текста у команды режима нет.
      const line = "мост Telegram: режим включён, тема «проба» (7); выключение — `/here`"
      const off = "мост Telegram: режим снят; включение — `/away`"
      const refused = "мост Telegram: режим не включён: служба отказала: bad-request"

      assert.deepEqual(said, [
        { sessionID: "ses_one", text: line, description: line, resume: false },
        { sessionID: "ses_two", text: line, description: line, resume: false },
        { sessionID: "ses_one", text: off, description: off, resume: false },
        { sessionID: "ses_one", text: refused, description: refused, resume: false },
      ])
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

// Реестр команд сервера OpenCode — словарь по имени (`add` — `set(name, …)`): одноимённая команда
// следующей копии плагина заменяет прежнюю. Поддельный хозяин держит тот же словарь на две копии.
test(
  "две копии плагина: команда /away одна, и вызов зовёт мост один раз",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-copies-"))
    const log = path.join(here, "mode.jsonl")
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
    const registry = new Map<string, Registered>()
    const said: string[] = []

    async function* stream(): AsyncGenerator<never> {}

    const client = {
      location: { directory: here },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        synthetic: async (input: { text: string }) => {
          said.splice(said.length, 0, input.text)

          return { id: `msg_${String(said.length)}` }
        },
      },
      event: { subscribe: () => stream() },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      command: {
        transform: async (callback: (editor: { add: (one: Registered) => void }) => void) => {
          callback({ add: (one: Registered) => registry.set(one.name, one) })

          return { dispose: async () => undefined }
        },
      },
    }

    const original = process.stderr.write

    try {
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = log
      process.env.FAKE_BRIDGE_MODE = "on"
      process.stderr.write = (() => true) as typeof process.stderr.write

      const first = await plugin.setup(client as unknown as Host)
      const second = await plugin.setup(client as unknown as Host)

      try {
        assert.deepEqual([...registry.keys()].sort(), ["away", "here"])

        await registry.get("away")?.execute({ sessionID: "ses_one", prompt: { text: "" } })

        for (let tick = 0; said.length < 1 && tick < 100; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } finally {
        first()
        second()
      }

      const calls = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")

      assert.equal(calls.length, 1, "мост позван не один раз")
      assert.equal(said.length, 1, "строк исхода не одна")
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

// Слово владельца, придержанное до режима, служба отдаёт сразу после включения — пока `/away` ещё
// идёт. Ход OpenCode вынимает из ящика сначала записи `steer`, и строка моста (`steer`) при слове
// `queue` ушла бы в ход одна, а слово — следующим ходом. Поэтому слово ждёт строку исхода и идёт
// `steer` вслед за ней: ход вынимает их вместе.
test(
  "слово, пришедшее во время /away, подаётся после строки исхода и доставкой steer",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-order-"))
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
    const added = new Map<string, Registered>()
    const calls: Array<{ call: string; detail: string }> = []
    const now = Date.now()
    const halt = new AbortController()

    async function* stream(): AsyncGenerator<Sent> {
      yield { type: "session.created", data: { sessionID: "ses_one" } }

      await new Promise((resolve) => halt.signal.addEventListener("abort", resolve))
    }

    const client = {
      location: { directory: here },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        get: async () => ({ location: { directory: here }, time: { created: now, updated: now } }),
        synthetic: async (input: { description: string }) => {
          calls.push({ call: "synthetic", detail: input.description })

          return { id: `msg_${String(calls.length)}` }
        },
        prompt: async (input: { text: string; delivery: string }) => {
          calls.push({ call: "prompt", detail: `${input.delivery}: ${input.text}` })
        },
      },
      event: { subscribe: () => stream() },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      command: {
        transform: async (callback: (editor: { add: (one: Registered) => void }) => void) => {
          callback({ add: (one: Registered) => added.set(one.name, one) })

          return { dispose: async () => undefined }
        },
      },
    }

    const original = process.stderr.write

    try {
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = path.join(here, "mode.jsonl")
      process.env.FAKE_BRIDGE_MODE = "on"
      process.env.FAKE_BRIDGE_AWAY_DELAY_MS = "1500"
      process.env.FAKE_BRIDGE_DELIVERY = JSON.stringify({
        event: "delivery",
        kind: "owner-message",
        delivery_id: "d-1",
        text: "Получил",
        provenance: "Доставлено из Telegram",
      })
      process.stderr.write = (() => true) as typeof process.stderr.write

      const close = await plugin.setup(client as unknown as Host)

      try {
        await added.get("away")?.execute({ sessionID: "ses_one", prompt: { text: "" } })

        for (let tick = 0; !calls.some((one) => one.call === "prompt") && tick < 300; tick += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      } finally {
        halt.abort()
        close()
      }

      assert.deepEqual(calls.slice(0, 2), [
        { call: "synthetic", detail: "мост Telegram: режим включён, тема «проба» (7); выключение — `/here`" },
        { call: "prompt", detail: "steer: Доставлено из Telegram\n\nПолучил" },
      ])
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

// Проводка хода и ящика в цикле событий: начало хода делает слово `queue`, конец хода снимает
// строку, которую ход застал, а лёгшую на простое — нет, событие вынимания снимает строку по id.
// Поток событий и доставки слов тест подаёт сам, по шагу.
test(
  "цикл событий ведёт ход и ящик: доставка слова по началу, концу хода и вниманию",
  { timeout: 20_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-watch-"))
    const inject = path.join(here, "inject")
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
    const added = new Map<string, Registered>()
    const notices: string[] = []
    const prompts: string[] = []
    const now = Date.now()
    const halt = new AbortController()
    const pending: Sent[] = []
    let wake: () => void = () => undefined

    async function* stream(): AsyncGenerator<Sent> {
      while (!halt.signal.aborted) {
        const next = pending.shift()
        if (next !== undefined) {
          yield next

          continue
        }

        await new Promise<void>((resolve) => {
          wake = resolve
          halt.signal.addEventListener("abort", () => resolve())
        })
      }
    }

    const push = async (type: string, extra: Record<string, string> = {}): Promise<void> => {
      pending.push({ type, data: { sessionID: "ses_one", ...extra } } as Sent)
      wake()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    let words = 0
    const word = async (): Promise<string> => {
      words += 1
      writeFileSync(
        path.join(inject, `${String(words)}.json`),
        JSON.stringify({
          event: "delivery",
          kind: "owner-message",
          delivery_id: `d-${String(words)}`,
          text: `слово ${String(words)}`,
          provenance: "Доставлено из Telegram",
        }),
      )

      for (let tick = 0; prompts.length < words && tick < 300; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      return prompts[words - 1] ?? "слово не подано"
    }

    const client = {
      location: { directory: here },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        get: async () => ({ location: { directory: here }, time: { created: now, updated: now } }),
        synthetic: async () => {
          notices.push(`msg_${String(notices.length + 1)}`)

          return { id: notices[notices.length - 1] }
        },
        prompt: async (input: { delivery: string }) => {
          prompts.push(input.delivery)
        },
      },
      event: { subscribe: () => stream() },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      command: {
        transform: async (callback: (editor: { add: (one: Registered) => void }) => void) => {
          callback({ add: (one: Registered) => added.set(one.name, one) })

          return { dispose: async () => undefined }
        },
      },
    }

    const original = process.stderr.write

    try {
      mkdirSync(inject)
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = path.join(here, "mode.jsonl")
      process.env.FAKE_BRIDGE_MODE = "on"
      process.env.FAKE_BRIDGE_INJECT = inject
      delete process.env.FAKE_BRIDGE_DELIVERY
      delete process.env.FAKE_BRIDGE_AWAY_DELAY_MS
      process.stderr.write = (() => true) as typeof process.stderr.write

      const close = await plugin.setup(client as unknown as Host)
      const seen: string[] = []

      try {
        await push("session.created")

        // Строка лежит, хода нет — слово вслед за ней `steer`.
        await added.get("away")?.execute({ sessionID: "ses_one", prompt: { text: "" } })
        seen.push(`простой со строкой: ${await word()}`)

        // Ход идёт — слово `queue`, идущий ход оно не подруливает.
        await push("session.execution.started")
        seen.push(`ход: ${await word()}`)

        // Конец хода снимает строку, которую ход застал, хотя события вынимания не было.
        await push("session.idle")
        seen.push(`после хода: ${await word()}`)

        // Строка, лёгшая на простое, концом хода без начала не снимается.
        await added.get("here")?.execute({ sessionID: "ses_one", prompt: { text: "" } })
        await push("session.idle")
        seen.push(`простой после конца без начала: ${await word()}`)

        // Событие вынимания снимает строку по её id.
        await push("session.inbox.delivered", { inboxID: notices[notices.length - 1] ?? "" })
        seen.push(`после вынимания: ${await word()}`)
      } finally {
        halt.abort()
        wake()
        close()
      }

      assert.deepEqual(seen, [
        "простой со строкой: steer",
        "ход: queue",
        "после хода: queue",
        "простой после конца без начала: steer",
        "после вынимания: queue",
      ])
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

/** CHAT — название чата, каким его отдаёт запись сессии в тесте. */
const CHAT = "Проверка моста"

/** RENAMED — название чата после переименования. */
const RENAMED = "Новое имя"

test(
  "название чата называется службе при соединении и на переименовании",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-name-"))
    const log = path.join(here, "names.jsonl")
    const front = path.join(here, "front.sock")
    const saved = new Map(NAMES.map((name) => [name, process.env[name]]))

    // Поток событий ведёт тест: сессия родилась, потом её переименовали.
    const queue: Sent[] = []
    let wake: (() => void) | undefined

    async function* stream(): AsyncGenerator<Sent> {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }

        const next = queue.shift()
        if (next === undefined) {
          return
        }

        yield next
      }
    }

    const send = (event: Sent): void => {
      queue.push(event)
      wake?.()
      wake = undefined
    }

    const now = Date.now()
    const client = {
      location: { directory: here },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        get: async () => ({
          location: { directory: here },
          time: { created: now, updated: now },
          title: CHAT,
        }),
        synthetic: async () => ({ id: "msg_0" }),
      },
      event: { subscribe: () => stream() },
      tool: { hook: async () => ({ dispose: async () => undefined }) },
      command: { transform: async () => ({ dispose: async () => undefined }) },
    }

    const original = process.stderr.write

    // Названия уходят без ожидания: тест ждёт нужного их числа в журнале поддельного моста.
    const reported = async (count: number): Promise<Array<{ path: string; body: string }>> => {
      for (let tick = 0; tick < 200; tick += 1) {
        const seen = readNames(log)
        if (seen.length >= count) {
          return seen
        }

        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      return readNames(log)
    }

    try {
      process.env.DM_TELEGRAM_BRIDGE = FAKE_BRIDGE
      process.env.FAKE_BRIDGE_LOG = log
      process.env.FAKE_BRIDGE_FRONT = front
      process.stderr.write = (() => true) as typeof process.stderr.write

      const stop = await plugin.setup(client as unknown as Host)

      try {
        send({ type: "session.created", data: { sessionID: "ses_имя" } })

        const first = await reported(1)
        assert.equal(first.length, 1, "название чата службе не названо")
        assert.equal(first[0]?.path, "/name")
        assert.deepEqual(JSON.parse(first[0]?.body ?? "{}"), { name: CHAT })

        send({ type: "session.renamed", data: { sessionID: "ses_имя", title: RENAMED } })

        const second = await reported(2)
        assert.equal(second.length, 2, "переименование чата до службы не дошло")
        assert.deepEqual(JSON.parse(second[1]?.body ?? "{}"), { name: RENAMED })
      } finally {
        stop()
      }
    } finally {
      process.stderr.write = original

      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }

      rmSync(here, { recursive: true, force: true })
    }
  },
)

/** readNames читает журнал поддельного моста: короткие запросы плагина по порядку. */
function readNames(log: string): Array<{ path: string; body: string }> {
  let text = ""

  try {
    text = readFileSync(log, "utf8")
  } catch {
    return []
  }

  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { path: string; body: string })
    .filter((one) => one.path === "/name")
}
