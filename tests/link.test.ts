// Соединение сессии на поддельной подкоманде `link` (`fake-link.mjs`): что плагин говорит владельцу
// о потере связи со службой и когда поднимает подкоманду заново. Служба моста и мост владельца
// тестом не трогаются.
//
// Запуск: `npm test` в корне репозитория.

import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import plugin from "../src/index.ts"
import { SessionLink } from "../src/link.ts"

/** Контекст, который сервер OpenCode отдаёт плагину. */
type Host = Parameters<typeof plugin.setup>[0]

/** Поддельная подкоманда: сценарий Node с первой строкой `#!`, без оболочки его запускает POSIX. */
const FAKE_LINK = path.resolve(import.meta.dirname, "fake-link.mjs")

/** Шаг поддельной подкоманды: строки выдачи и код выхода; без кода она живёт. */
type Step = { lines: string[]; code?: number }

/** Переменные окружения, которые тест ставит и обязан вернуть. */
const NAMES = ["DM_TELEGRAM_BRIDGE", "FAKE_LINK_COUNT", "FAKE_LINK_PLAN", "DM_TELEGRAM_OPENCODE_PAUSE_SECONDS"] as const

const ready = JSON.stringify({ event: "ready", socket: "/nowhere/l.sock", mode: "on" })
const lost = JSON.stringify({ event: "lost", text: "соединение со службой потеряно" })
const absent = JSON.stringify({ event: "absent", text: "службы нет 30 с, жду её и подключусь сам" })
const fault = JSON.stringify({ event: "error", code: "bad-request", text: "соединение больше не держит сессию" })

/** staged ставит окружение поддельной подкоманды на время тела и возвращает прежнее. */
async function staged<T>(plan: Step[], extra: Record<string, string>, body: (count: string) => Promise<T>): Promise<T> {
  const here = mkdtempSync(path.join(tmpdir(), "dmtg-link-"))
  const count = path.join(here, "runs.txt")
  const saved = new Map(NAMES.map((name) => [name, process.env[name]]))

  chmodSync(FAKE_LINK, 0o755)

  try {
    process.env.DM_TELEGRAM_BRIDGE = FAKE_LINK
    process.env.FAKE_LINK_COUNT = count
    process.env.FAKE_LINK_PLAN = JSON.stringify(plan)

    for (const [name, value] of Object.entries(extra)) {
      process.env[name] = value
    }

    return await body(count)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }

    rmSync(here, { recursive: true, force: true })
  }
}

/** runs читает, сколько раз запускалась поддельная подкоманда. */
function runs(count: string): number {
  try {
    return readFileSync(count, "utf8").split("\n").filter((line) => line !== "").length
  } catch {
    return 0
  }
}

/** until ждёт, пока условие не станет верным, но не дольше срока. */
async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const edge = Date.now() + ms

  while (!ok()) {
    if (Date.now() > edge) {
      assert.fail(`не дождались: ${what}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** linked поднимает одно соединение сессии и отдаёт сказанное владельцу и исход его конца. */
function linked(): { link: SessionLink; spoken: string[]; ended: Array<{ how: string; again: boolean }> } {
  const spoken: string[] = []
  const ended: Array<{ how: string; again: boolean }> = []

  const link = new SessionLink("ses_link", {
    deliver: async () => ({ outcome: "rejected", detail: "в тесте не подаётся" }),
    speak: (line: string) => spoken.push(line),
    ended: (how: string, again: boolean) => ended.push({ how, again }),
  })

  link.start()

  return { link, spoken, ended }
}

/** quiet глушит строки плагина в поток ошибок на время тела и отдаёт их. */
async function quiet(body: (lines: string[]) => Promise<void>): Promise<void> {
  const original = process.stderr.write
  const lines: string[] = []

  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))

    return true
  }) as typeof process.stderr.write

  try {
    await body(lines)
  } finally {
    process.stderr.write = original
  }
}

test(
  "штатный перезапуск службы проходит молча: потеря связи и возврат владельцу не говорятся",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    await quiet(async (notes) => {
      await staged([{ lines: [ready, lost, ready] }], {}, async () => {
        const { link, spoken } = linked()

        try {
          await until("второе событие ready", () => notes.filter((line) => line.includes("открыто")).length >= 2)

          assert.deepEqual(spoken, [])
        } finally {
          link.stop()
        }
      })
    })
  },
)

test(
  "долгая пропажа службы слышна владельцу, а возврат снимает сказанное",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    await quiet(async () => {
      await staged([{ lines: [ready, lost, absent, ready] }], {}, async () => {
        const { link, spoken } = linked()

        try {
          await until("возврат сказан", () => spoken.length >= 2)

          assert.deepEqual(spoken, ["службы нет 30 с, жду её и подключусь сам", "канал вернулся"])
        } finally {
          link.stop()
        }
      })
    })
  },
)

test(
  "подкоманда умерла не отказом — владелец слышит, что канала нет, и её надо поднять заново",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    await quiet(async () => {
      await staged([{ lines: [ready], code: 1 }], {}, async () => {
        const { spoken, ended } = linked()

        await until("конец соединения", () => ended.length === 1)

        assert.deepEqual(ended, [{ how: "код 1", again: true }])
        assert.deepEqual(spoken, ["канала нет, соединение кончилось (код 1); поднимаю заново"])
      })
    })
  },
)

test(
  "подкоманда, ни разу не открывшая соединение, заново сама не поднимается: мост не настроен",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    await quiet(async () => {
      await staged([{ lines: [], code: 2 }], {}, async () => {
        const { spoken, ended } = linked()

        await until("конец соединения", () => ended.length === 1)

        assert.deepEqual(ended, [{ how: "код 2", again: false }])
        assert.deepEqual(spoken, ["канала нет, соединение кончилось (код 2)"])
      })
    })
  },
)

test(
  "отказ службы событием `error` подкоманду заново не поднимает: второй держатель отбирал бы сессию",
  { timeout: 10_000, skip: process.platform === "win32" },
  async () => {
    await quiet(async () => {
      await staged([{ lines: [ready, fault], code: 1 }], {}, async () => {
        const { spoken, ended } = linked()

        await until("конец соединения", () => ended.length === 1)

        assert.deepEqual(ended, [{ how: "код 1", again: false }])
        assert.deepEqual(spoken, ["соединение больше не держит сессию"])
      })
    })
  },
)

/** host — поддельный сервер OpenCode с одной свежей сессией папки плагина и пустым потоком событий. */
function host(here: string, stopped: Promise<void>): Host {
  async function* stream(): AsyncGenerator<never> {
    await stopped
  }

  const now = Date.now()

  return {
    location: { directory: here },
    session: {
      list: async () => ({
        data: [{ id: "ses_respawn", location: { directory: here }, time: { created: now, updated: now }, title: "" }],
        cursor: { next: null },
      }),
    },
    event: { subscribe: () => stream() },
    tool: { hook: async () => ({ dispose: async () => undefined }) },
    command: { transform: async () => ({ dispose: async () => undefined }) },
  } as unknown as Host
}

test(
  "плагин поднимает умершую подкоманду сам, через паузу и без события сессии",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-respawn-"))
    let release: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await quiet(async (notes) => {
        const plan: Step[] = [{ lines: [ready], code: 1 }, { lines: [ready] }]

        await staged(plan, { DM_TELEGRAM_OPENCODE_PAUSE_SECONDS: "0.3" }, async (count) => {
          const stop = await plugin.setup(host(here, stopped))

          try {
            await until("второй запуск подкоманды", () => runs(count) >= 2)
            await until(
              "второй запуск открыл соединение",
              () => notes.filter((line) => line.includes("ses_respawn: соединение со службой открыто")).length >= 2,
            )

            // Живая подкоманда заново не поднимается: третьего запуска нет.
            await new Promise((resolve) => setTimeout(resolve, 600))
            assert.equal(runs(count), 2)
            assert.ok(
              notes.some((line) => line.includes("канала нет, соединение кончилось (код 1); поднимаю заново")),
              "о смерти подкоманды не сказано",
            )
          } finally {
            stop()
          }
        })
      })
    } finally {
      release?.()
      rmSync(here, { recursive: true, force: true })
    }
  },
)

test(
  "отказ службы плагин заново не поднимает и без события сессии",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const here = mkdtempSync(path.join(tmpdir(), "dmtg-refused-"))
    let release: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await quiet(async () => {
        await staged([{ lines: [ready, fault], code: 1 }], { DM_TELEGRAM_OPENCODE_PAUSE_SECONDS: "0.2" }, async (count) => {
          const stop = await plugin.setup(host(here, stopped))

          try {
            await until("первый запуск подкоманды", () => runs(count) >= 1)
            await new Promise((resolve) => setTimeout(resolve, 900))

            assert.equal(runs(count), 1)
          } finally {
            stop()
          }
        })
      })
    } finally {
      release?.()
      rmSync(here, { recursive: true, force: true })
    }
  },
)
