// Тесты чистых кусков плагина: разводка доставки, разбор строки команды, сверка путей, порядок
// вытеснения и разбор ответа `away status`. Живого сервера OpenCode у тестов нет, поэтому
// проверяется то, что от хозяина не зависит; цикл событий `setup` на поддельном клиенте — в
// `setup.test.ts`, а подача слова и живой дочерний процесс остаются на сквозном прогоне.
//
// Запуск: `npm test` в корне репозитория — проверка типов, затем
// `node --test --experimental-strip-types "tests/*.test.ts"`. Сам `node --test` типы только срезает,
// поэтому без первого шага они не проверялись бы вовсе.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { numeric, owned, pluginID, pluginRoot, samePath, treeRoot } from "../src/bridge.ts"
import { accepted, head, plan, rejected } from "../src/delivery.ts"
import { bound, claim, lost, spoken, stalest, waiting } from "../src/index.ts"
import { args, summary } from "../src/mode.ts"
import { payload, verdict } from "../src/question.ts"
import { parse } from "../src/status.ts"

/** Провенанс доставки: готовая строка, которую плагин приклеивает к подаче. */
const PROVENANCE = "Доставлено из Telegram, автор Александр, человек"

test("слово владельца подаётся с провенансом первыми строками", () => {
  const todo = plan({ kind: "owner-message", delivery_id: "d-1", text: "посмотри на диффе", provenance: PROVENANCE })

  assert.deepEqual(todo, { act: "word", text: `${PROVENANCE}\n\nпосмотри на диффе` })
})

test("доставка без текста или без провенанса в сессию не подаётся", () => {
  const detail = "доставка без текста или без провенанса"

  assert.deepEqual(plan({ kind: "owner-message", text: "", provenance: PROVENANCE }), { act: "refuse", detail })
  assert.deepEqual(plan({ kind: "owner-message", text: "слово", provenance: "" }), { act: "refuse", detail })
})

test("команда из темы разводится на имя и аргументы", () => {
  assert.deepEqual(plan({ kind: "client-command", text: "/compact покороче" }), {
    act: "command",
    name: "compact",
    args: "покороче",
  })
  assert.deepEqual(plan({ kind: "client-command", text: "  /here  " }), { act: "command", name: "here", args: "" })
})

test("команда без имени не исполняется", () => {
  assert.deepEqual(plan({ kind: "client-command", text: "/ " }), { act: "refuse", detail: "команда без имени" })
})

test("доставка незнакомого вида в сессию не подаётся, и причина названа", () => {
  assert.deepEqual(plan({ kind: "owner-whisper", text: "слово" }), {
    act: "refuse",
    detail: "доставка незнакомого вида owner-whisper",
  })
  assert.deepEqual(plan({ text: "слово" }), { act: "refuse", detail: "доставка незнакомого вида ?" })
})

test("head отрезает имя команды от аргументов", () => {
  assert.deepEqual(head("/project-status"), { name: "project-status", args: "" })
  assert.deepEqual(head("//away тема"), { name: "away", args: "тема" })
  assert.deepEqual(head("compact и ещё аргумент"), { name: "compact", args: "и ещё аргумент" })
  assert.deepEqual(head("   "), { name: "", args: "" })
})

test("исход подачи — один из двух, и честь без причины", () => {
  assert.deepEqual(accepted, { outcome: "accepted", detail: "" })
  assert.deepEqual(rejected("подача не прошла"), { outcome: "rejected", detail: "подача не прошла" })
})

test("каталоги сверяются по настоящему пути, а не по строке", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dmtg-test-"))

  try {
    const alias = path.join(dir, "ссылка")

    symlinkSync(path.join(dir, "."), alias)

    assert.equal(samePath(alias, dir), true, "ссылка на каталог — тот же каталог")
    assert.equal(samePath(dir, dir), true)
    assert.equal(samePath(dir, path.join(dir, "другой")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("пути, которых нет, сверяются как есть", () => {
  assert.equal(samePath("/нет/такого/пути", "/нет/такого/пути"), true)
  assert.equal(samePath("/нет/такого/пути", "/нет/другого/пути"), false)
})

test("число из окружения: пусто — своё, негодное — отказ", () => {
  const name = "DM_TELEGRAM_TEST_NUMBER"

  delete process.env[name]
  assert.equal(numeric(name, 16), 16)

  process.env[name] = ""
  assert.equal(numeric(name, 16), 16)

  process.env[name] = "4"
  assert.equal(numeric(name, 16), 4)

  for (const bad of ["0", "-1", "много"]) {
    process.env[name] = bad
    assert.throws(() => numeric(name, 16), /ждали положительное число/)
  }

  delete process.env[name]
})

test("вытесняется самая старая по работе, а пустой набор не называет никого", () => {
  assert.equal(stalest(new Map()), undefined)

  const held = new Map([
    ["ses-свежая", { seen: 300 }],
    ["ses-старая", { seen: 100 }],
    ["ses-средняя", { seen: 200 }],
  ])

  assert.deepEqual(stalest(held), { id: "ses-старая", seen: 100 })
})

test("после смерти подкоманды попытка держится паузой, а не идёт каждым событием", () => {
  const pause = 30_000

  assert.equal(waiting(undefined, 1_000_000, pause), false, "неудач не было — пробуем сразу")
  assert.equal(waiting(1_000_000, 1_000_001, pause), true, "событие через миллисекунду — рано")
  assert.equal(waiting(1_000_000, 1_000_000 + pause - 1, pause), true, "пауза ещё не вышла")
  assert.equal(waiting(1_000_000, 1_000_000 + pause, pause), false, "пауза вышла — пробуем снова")
})

test("потеря темы: режим был, а в ответе службы его и темы нет", () => {
  assert.equal(lost(true, "off", ""), true, "тему занял кто-то другой")
  assert.equal(lost(true, "off", undefined), true, "темы в ответе нет вовсе")
  assert.equal(lost(true, "off", "зонд"), false, "режим снят словом владельца, привязка цела")
  assert.equal(lost(true, "on", "зонд"), false, "режим на месте")
  assert.equal(lost(false, "off", ""), false, "режима и не было")
  assert.equal(lost(undefined, "off", ""), false, "прежний режим неизвестен — утверждать нечего")
})

test("ответ away status читается, а отказ не читается как снятый режим", () => {
  assert.deepEqual(parse(0, '{"mode":"on","topic_id":42,"topic_name":"зонд"}'), { away: true, topic: "зонд" })
  assert.deepEqual(parse(0, '{"mode":"off","topic_id":42,"topic_name":"зонд"}'), { away: false, topic: "зонд" })
  assert.deepEqual(parse(0, '{"mode":"off","topic_name":""}'), { away: false, topic: null })

  assert.equal(parse(1, '{"mode":"on","topic_name":"зонд"}'), null, "ненулевой код — состояние неизвестно")
  assert.equal(parse(0, "служба не отвечает"), null, "не-JSON — состояние неизвестно")
  assert.equal(parse(0, "{}"), null, "ответ без режима — состояние неизвестно")
  assert.equal(parse(null, ""), null, "процесс убит пределом ожидания — состояние неизвестно")
})

test("граница хода называется по виду события сервера", () => {
  assert.equal(bound("session.execution.started"), "start")
  assert.equal(bound("session.execution.succeeded"), "end")
  assert.equal(bound("session.execution.failed"), "end")
  assert.equal(bound("session.execution.interrupted"), "end")
  assert.equal(bound("session.idle"), "end")
  assert.equal(bound("session.created"), undefined)
  assert.equal(bound("session.deleted"), undefined)
  assert.equal(bound("message.updated"), undefined)
})

test("дописанная реплика агента называется видом события, а не разбором текста", () => {
  const said = { sessionID: "s-1", assistantMessageID: "m-1", ordinal: 0, text: "читаю диффы" }

  assert.equal(spoken("session.text.ended", said), "читаю диффы", "конец реплики объявляет сервер")
  assert.equal(spoken("session.text.started", said), undefined, "начатая реплика в тему не уходит")
  assert.equal(
    spoken("session.reasoning.ended", { sessionID: "s-1", text: "взвешиваю" }),
    undefined,
    "мысли в тему не уходят",
  )
  assert.equal(
    spoken("session.tool.success", { sessionID: "s-1", content: [{ type: "text", text: "вывод" }] }),
    undefined,
    "вывод инструмента в тему не уходит",
  )
  assert.equal(
    spoken("session.tool.input.ended", { sessionID: "s-1", text: '{"file_path":"a.go"}' }),
    undefined,
    "вход инструмента в тему не уходит",
  )
  assert.equal(spoken("session.step.ended", { sessionID: "s-1" }), undefined, "конец шага сам по себе не реплика")
  assert.equal(bound("session.text.ended"), undefined, "конец реплики границей хода не считается")
})

test("пустая реплика сообщением не становится", () => {
  assert.equal(spoken("session.text.ended", { text: "" }), undefined, "отправлять нечего")
  assert.equal(spoken("session.text.ended", { text: "  \n " }), undefined, "одни пробелы — тоже нечего")
  assert.equal(spoken("session.text.ended", {}), undefined, "текста в событии нет — угадывать нечего")
  assert.equal(spoken("session.text.ended", { text: " готово\n" }), "готово", "края обрезаются, текст цел")
})

test("id копии плагина из worktree несёт имя дерева, и у двух копий они разные", () => {
  const base = "opencode-telegram-bridge"
  const first = pluginID(base, "/tmp/repo/.claude/worktrees/tg-a")
  const second = pluginID(base, "/tmp/repo/.claude/worktrees/tg-b")

  assert.equal(first, `${base}.tg-a`, "копия worktree получает имя своего дерева")
  assert.notEqual(first, second, "две копии в одном сервере не спорят за один id")
})

test("копия, поставленная из Git-адреса, зовётся базовым id и git не спрашивает", () => {
  const base = "opencode-telegram-bridge"
  const root = "/tmp/npm/opencode-telegram-bridge"

  assert.equal(pluginID(base, root), base, "вне worktree id базовый")
  assert.equal(pluginID(base, "/tmp/repo"), base, "основное дерево репозитория — тоже базовый id")
})

test("корень пакета считается от файла в src, а не от дерева сессии", () => {
  assert.equal(
    pluginRoot("file:///tmp/npm/opencode-telegram-bridge/src/bridge.ts"),
    "/tmp/npm/opencode-telegram-bridge",
    "в корне пакета лежат index.ts и src/",
  )
})

test("копия вне worktree рисует строку любой сессии, копия worktree — только своего дерева", () => {
  const anywhere = "/tmp/npm/opencode-telegram-bridge"

  assert.equal(owned(anywhere, "/tmp/repo/apps/game"), true, "одна копия на сервер — все сессии её")
  assert.equal(
    owned("/tmp/repo/.claude/worktrees/tg-a", "/tmp/repo/.claude/worktrees/tg-a/apps/game"),
    true,
    "копия worktree видит сессию своего дерева",
  )
  assert.equal(
    owned("/tmp/repo/.claude/worktrees/tg-a", "/tmp/repo/.claude/worktrees/tg-b/apps/game"),
    false,
    "сессия соседнего дерева — чужая",
  )
})

test("каталог сессии внутри worktree — то же дерево", () => {
  assert.equal(treeRoot("/tmp/repo/.claude/worktrees/tg-a/apps/game"), "/tmp/repo/.claude/worktrees/tg-a")
  assert.notEqual(
    treeRoot("/tmp/repo/.claude/worktrees/tg-a/apps/game"),
    treeRoot("/tmp/repo/.claude/worktrees/tg-b/apps/client"),
    "соседние деревья — разные",
  )
})

test("исход hook ask читается по правилам хука Claude Code", () => {
  const deny = JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "вопрос в теме" },
  })

  assert.deepEqual(verdict(0, `${deny}\n`, ""), { act: "refuse", reason: "вопрос в теме" }, "вопрос ушёл в тему")
  assert.deepEqual(verdict(0, "", ""), { act: "dialog", detail: "" }, "режим снят — диалог без строки")
  assert.deepEqual(
    verdict(0, "", "мост Telegram: службы нет\n"),
    { act: "dialog", detail: "мост Telegram: службы нет" },
    "службы нет — диалог, причина названа",
  )
  assert.deepEqual(
    verdict(2, "", "вопрос в тему не ушёл — задай его текстом хода\n"),
    { act: "refuse", reason: "вопрос в тему не ушёл — задай его текстом хода" },
    "беда канала — отказ с причиной подкоманды",
  )
  assert.deepEqual(verdict(2, "", ""), { act: "refuse", reason: "мост Telegram отказал без причины" })
  assert.deepEqual(verdict(1, "", "unknown flag"), { act: "dialog", detail: "hook ask кончился кодом 1: unknown flag" })
  assert.deepEqual(verdict(null, "", ""), { act: "dialog", detail: "hook ask кончился кодом null" })
})

test("непонятный ответ hook ask — отказ, а не диалог и не молчание", () => {
  for (const printed of ["не JSON", JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })]) {
    const result = verdict(0, printed, "")

    assert.equal(result.act, "refuse", printed)
    assert.match(result.act === "refuse" ? result.reason : "", /ответил на вопрос непонятно/)
  }
})

test("нагрузка hook ask — форма хука Claude Code, `multiple` становится `multiSelect`", () => {
  const input = {
    questions: [
      { header: "Х", question: "Что?", multiple: false, options: [{ label: "а", description: "первое" }] },
      { header: "", question: "Ещё?", options: [] },
    ],
  }

  assert.deepEqual(JSON.parse(payload("ses_1", input)), {
    session_id: "ses_1",
    tool_input: {
      questions: [
        { header: "Х", question: "Что?", multiSelect: false, options: [{ label: "а", description: "первое" }] },
        { header: "", question: "Ещё?", options: [] },
      ],
    },
  })
  assert.deepEqual(JSON.parse(payload("ses_1", "негодный вход")), { session_id: "ses_1", tool_input: "негодный вход" })
})

// Образец формы сервера OpenCode 2.1.4: поле `multiple` модель может не прислать. Здесь — первый
// шаг хука: вход инструмента `question` становится ровно нагрузкой хука Claude Code.
test("вход question OpenCode становится нагрузкой, которую служба кладёт в тему целиком", () => {
  const sample = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "testdata/opencode-question.json"), "utf8"),
  ) as { input: unknown; payload: { session_id: string } }

  assert.deepEqual(JSON.parse(payload(sample.payload.session_id, sample.input)), sample.payload)
})

test("аргументы команд режима: имя темы одной строкой, пустое не передаётся", () => {
  assert.deepEqual(args("on", "ses_1", " две части "), ["away", "on", "две части", "--session", "ses_1"])
  assert.deepEqual(args("on", "ses_1", "   "), ["away", "on", "--session", "ses_1"])
  assert.deepEqual(args("off", "ses_1", "лишнее"), ["away", "off", "--session", "ses_1"])
})

test("исход команды режима: строка подкоманды или её причина, а не догадка", () => {
  assert.equal(summary("on", 0, "режим включён, тема «т» (1)\n", ""), "режим включён, тема «т» (1); выключение — `/here`")
  assert.equal(summary("off", 0, "режим снят\n", ""), "режим снят; включение — `/away`")
  assert.equal(summary("on", 3, "", "служба не отвечает\n"), "режим не включён: служба не отвечает")
  assert.equal(summary("off", 2, "", ""), "режим не снят: away off кончился кодом 2")
  assert.equal(summary("on", null, "", ""), "режим не включён: away on кончился кодом null")
})

test("вызов вопроса берёт один экземпляр плагина, ключ — сессия, сообщение и id вызова", () => {
  assert.equal(claim("ses-a", "msg-1", "call_0"), true, "первый взял")
  assert.equal(claim("ses-a", "msg-1", "call_0"), false, "второй тот же вызов не берёт")
  assert.equal(claim("ses-a", "msg-1", "call_1"), true, "другой вызов — свой")
  assert.equal(claim("ses-b", "msg-1", "call_0"), true, "тот же id в другой сессии берётся заново")
  assert.equal(claim("ses-a", "msg-2", "call_0"), true, "тот же id в другом сообщении берётся заново")
})
