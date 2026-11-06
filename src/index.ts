// Средство сессии OpenCode: та же роль доставки, что у мода Claude Code. Соединение со службой
// держит та же подкоманда `telegram-bridge link`, слово владельца подаётся новым ходом, команда из
// темы исполняется как набранная владельцем, а приём подтверждается только после того, как подача
// разрешилась. Протокол и роли — `contract.md` службы `github.com/kerbyfc/telegram-bridge`.
//
// Своего поведения темы у плагина нет: отметки доставки, поток реплик и жизненный цикл темы ведёт
// служба, и по теме не видно, какой клиент за сессией.
//
// Отличие от мода одно, и причина в устройстве самого OpenCode: у мода один процесс на сессию, а
// плагин живёт в сервере, который держит много сессий сразу. Поэтому соединение здесь не одно, а
// по одному на сессию, которую плагин считает живой, — см. `attend`.
//
// Тихих решений здесь нет ни одного: каждое «эту сессию не держим» и каждая потеря канала идут
// строкой в поток ошибок сервера, а потеря канала — ещё и словом владельцу в самой сессии.

import type { Plugin } from "@opencode/plugin"

import { adoptSettings, note, numeric, pluginID, pluginRoot, reason, samePath } from "./bridge.ts"
import { accepted, plan, rejected } from "./delivery.ts"
import { SessionLink, type Linked, type Taken } from "./link.ts"
import { toggle } from "./mode.ts"
import { Notices } from "./notice.ts"
import { ask, QUESTION_TOOL } from "./question.ts"

/**
 * Сколько соединений плагин держит разом. Предел нужен потому, что «жива» у OpenCode не измеряется
 * процессом: сессия остаётся в сервере и после того, как владелец её бросил, и без предела
 * соединения копились бы со всей историей проекта.
 */
const LINKS = 16

/**
 * Какой свежести сессии плагин держит. Порог один на две работы, и это не совпадение: сессия,
 * которую не трогали дольше него, считается брошенной — со старта она не поднимается, а при упоре
 * в предел её соединение снимается. Сессия свежее порога канала не теряет никогда.
 */
const REVIVE_HOURS = 12

/**
 * Сколько записей сессий плагин просматривает на старте. Порядок, в котором список отдаёт сессии,
 * клиент не обещает ни одним полем, поэтому свежесть считается здесь самим плагином, а страницы
 * читаются до конца — предел стоит на случай истории размером с проект и слышен строкой.
 */
const SCAN = 500

/** Размер страницы списка сессий. С пределом соединений он не связан: это разные счёты. */
const PAGE = 100

/**
 * Пауза между попытками поднять соединение после того, как подкоманда умерла. Своя пауза
 * подкоманды (`--retry`, 5 с) ведёт обрыв связи с живой службой; эта — смерть самой подкоманды, и
 * она нарочно длиннее: причина такой смерти стойкая (нет бинаря, нет настроек, чужая версия
 * контракта), а события у работающей сессии идут десятками в секунду.
 */
const PAUSE_SECONDS = 30

/** attendant — соединение одной сессии и время её последней работы: по нему идёт вытеснение. */
type attendant = {
  link: SessionLink
  seen: number
}

/**
 * sessionInfo — то, что плагину нужно знать о сессии: своя ли она ему, не дочерняя ли и когда её
 * трогали. Тип структурный, а не привозной: полные типы сессии живут в клиенте OpenCode, а здесь
 * читаются ровно эти поля.
 */
type sessionInfo = {
  readonly parentID?: string
  readonly location: { readonly directory: string }
  readonly time: { readonly created: number; readonly updated: number; readonly viewed?: number }
  /** Название чата: имя темы без аргумента служба берёт из него. */
  readonly title?: string
}

/**
 * Реестр держателей на весь процесс сервера. Один сервер OpenCode поднимает плагин несколькими
 * экземплярами — по папке и при повторной загрузке, — и соединение сессии у протокола одно:
 * второе приветствие вытеснило бы первое, и слово владельца пошло бы по кругу. Поэтому сессию
 * держит тот экземпляр, который взял её первым.
 */
const HOLDERS = Symbol.for("dm-opencode-telegram-bridge:holders")

/** holders — id сессий, которые в этом процессе уже кем-то держатся. */
function holders(): Set<string> {
  const host = globalThis as { [HOLDERS]?: Set<string> }

  host[HOLDERS] ??= new Set<string>()

  return host[HOLDERS]
}

/**
 * Реестр вызовов вопроса на весь процесс сервера. Обработчик `tool.execute.before` ставит каждый
 * экземпляр плагина, а вопрос у вызова один: отдай его подкоманде два экземпляра — владелец получил
 * бы его в тему дважды. Поэтому вызов отдаёт тот экземпляр, который увидел его первым.
 */
const ASKED = Symbol.for("dm-opencode-telegram-bridge:asked")

/** Сколько id вызовов реестр помнит: старые вызовы второй раз не приходят, и память им не нужна. */
const ASKED_KEEP = 256

/**
 * claim отвечает, первым ли этот экземпляр взял вызов вопроса, и помнит его. Ключ — сессия, сообщение
 * и id вызова вместе: id вызова инструмента у ряда провайдеров приходит от модели и бывает коротким и
 * повторным (`call_0`), и по нему одному чужой вызов считался бы уже взятым — вопрос молча остался бы
 * диалогом в режиме, где его некому увидеть.
 */
export function claim(sessionID: string, messageID: string, callID: string): boolean {
  const host = globalThis as { [ASKED]?: Set<string> }
  const seen = (host[ASKED] ??= new Set<string>())
  const key = JSON.stringify([sessionID, messageID, callID])

  if (seen.has(key)) {
    return false
  }

  seen.add(key)

  for (const old of seen) {
    if (seen.size <= ASKED_KEEP) {
      break
    }

    seen.delete(old)
  }

  return true
}

/** touched — когда сессию трогали последний раз: правка или взгляд владельца. */
export function touched(info: sessionInfo): number {
  return Math.max(info.time.updated, info.time.viewed ?? 0, info.time.created)
}

/**
 * waiting отвечает, рано ли пробовать соединение снова: `since` — когда прошлая попытка кончилась
 * смертью подкоманды, `undefined` — неудач не было. Пауза держит плагин от петли спавна: события
 * работающей сессии идут десятками в секунду, а причина смерти подкоманды стойкая.
 */
export function waiting(since: number | undefined, now: number, pause: number): boolean {
  return since !== undefined && now - since < pause
}

/**
 * lost отвечает, потеряла ли сессия тему, пока канала не было: режим у неё был, а в ответе службы
 * его больше нет и темы тоже. Режим, снятый словом владельца, темы не теряет — привязка остаётся, —
 * поэтому пустое имя темы и есть признак того, что тему занял кто-то другой. Прежний режим
 * неизвестен (плагин только поднялся) — утверждать нечего.
 */
export function lost(was: boolean | undefined, mode: string | undefined, topic: string | undefined): boolean {
  return was === true && mode !== "on" && (topic === undefined || topic === "")
}

/**
 * stalest называет самую старую по работе сессию из держимых и когда её трогали. Пустой набор
 * сессии не называет: вытеснять нечего.
 */
export function stalest(held: ReadonlyMap<string, { seen: number }>): { id: string; seen: number } | undefined {
  let found: { id: string; seen: number } | undefined

  for (const [id, one] of held) {
    if (found === undefined || one.seen < found.seen) {
      found = { id, seen: one.seen }
    }
  }

  return found
}

/**
 * spoken называет дописанную реплику агента по событию сервера. Конец реплики объявляет сам
 * сервер: событие `session.text.ended` приходит, когда блок текста дописан, и несёт весь его текст
 * — собирать куски и угадывать конец плагину не приходится.
 *
 * Мысли идут событиями `session.reasoning.*`, вызов инструмента и его вход — `session.tool.*`, шаг
 * — `session.step.*`: в тему они не попадают по виду события, а не по разбору текста. Реплика из
 * одних пробелов сообщением не становится — отправлять нечего, и Bot API пустого текста не примет.
 */
export function spoken(type: string, data: unknown): string | undefined {
  if (type !== "session.text.ended") {
    return undefined
  }

  const said = (data as { readonly text?: unknown }).text
  if (typeof said !== "string") {
    return undefined
  }

  const text = said.trim()

  return text === "" ? undefined : text
}

/**
 * bound называет границу хода по виду события сервера: исполнение началось — ход начался; удача,
 * отказ, прерывание владельцем и простой сессии — ход кончился. Своего события «ход кончился» у
 * сервера нет вовсе, поэтому названы все четыре, и повторный конец службе не вреден — гасить
 * погасшее действие чата она умеет. Остальные события границей хода не считаются.
 */
export function bound(type: string): "start" | "end" | undefined {
  if (type === "session.execution.started") {
    return "start"
  }

  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted" ||
    type === "session.idle"
  ) {
    return "end"
  }

  return undefined
}

/**
 * taken называет запись ящика, которую сервер вынул в ход или отменил: события
 * `session.inbox.delivered` и `session.inbox.cancelled` несут её id полем `inboxID`. Остальные
 * события записи не называют.
 */
export function taken(type: string, data: unknown): string | undefined {
  if (type !== "session.inbox.delivered" && type !== "session.inbox.cancelled") {
    return undefined
  }

  const id = (data as { readonly inboxID?: unknown } | undefined)?.inboxID

  return typeof id === "string" && id !== "" ? id : undefined
}

export default {
  // Id копии уникален на дерево: копия каталога есть в каждом worktree, и два одинаковых id сервер
  // считает ошибкой. Сессии каждая копия всё равно держит только свои — по `own` ниже.
  id: pluginID("opencode-telegram-bridge", pluginRoot(import.meta.url)),
  setup: async (context) => {
    adoptSettings()

    const links = numeric("DM_TELEGRAM_OPENCODE_LINKS", LINKS)
    const revive = numeric("DM_TELEGRAM_OPENCODE_REVIVE_HOURS", REVIVE_HOURS) * 3600 * 1000
    const scan = numeric("DM_TELEGRAM_OPENCODE_SCAN", SCAN)
    const pause = numeric("DM_TELEGRAM_OPENCODE_PAUSE_SECONDS", PAUSE_SECONDS) * 1000
    const here = context.location.directory
    const hours = (revive / 3600 / 1000).toString()

    /** held — соединения сессий этой папки. */
    const held = new Map<string, attendant>()
    /** strangers — сессии, которые плагину не его: дочерние сессии агентов и сессии другой папки. */
    const strangers = new Set<string>()
    /**
     * told — сессии, которым об отсутствии канала уже сказано: одно и то же не повторяется. Имя
     * нарочно не `spoken`: так зовётся разбор события выше, и одноимённое множество закрыло бы его
     * внутри `setup`.
     */
    const told = new Set<string>()
    /** failed — когда у сессии последний раз умерла подкоманда: по нему держится пауза попыток. */
    const failed = new Map<string, number>()
    /** modes — режим, которым служба назвала сессию последним: по нему видно потерю темы. */
    const modes = new Map<string, boolean>()
    /** revivals — отложенный подъём соединения сессии, чья подкоманда умерла не отказом службы. */
    const revivals = new Map<string, ReturnType<typeof setTimeout>>()

    /**
     * respawn поднимает соединение сессии заново через паузу. Сессия, которую за это время сняли
     * (удалена, переехала, плагин погашен) или подняли событием, заново не поднимается.
     */
    function respawn(sessionID: string, seen: number): void {
      forgetRevival(sessionID)

      const timer = setTimeout(() => {
        revivals.delete(sessionID)

        if (stop.signal.aborted || held.has(sessionID)) {
          return
        }

        attend(sessionID, seen)
      }, pause)

      // Отложенный подъём процесс сервера не держит: сервер выходит, когда ему пора.
      timer.unref()
      revivals.set(sessionID, timer)
    }

    /** forgetRevival снимает отложенный подъём соединения сессии. */
    function forgetRevival(sessionID: string): void {
      clearTimeout(revivals.get(sessionID))
      revivals.delete(sessionID)
    }
    /**
     * notices — строки моста, которые ещё в пути или лежат в ящике сервера, и ход сессии: по ним
     * подаётся слово. Границы хода плагин читает из потока событий.
     */
    const notices = new Notices()
    /** Остановка подписки на события: плагин перезагружается, и прежний поток событий не нужен. */
    const stop = new AbortController()

    /**
     * post кладёт строку моста в сессию и отдаёт id записи ящика; не легла — `undefined` и строка в
     * поток ошибок. Это и есть «своими средствами» из контракта: подачи служебной строки моста от
     * имени владельца не бывает, поэтому строка идёт синтетическим сообщением и хода не начинает.
     *
     * Окно OpenCode показывает синтетическое сообщение одной строкой его описания, а текст отдаёт
     * только модели. Поэтому исход идёт описанием, а текст несёт его же.
     */
    async function post(sessionID: string, line: string): Promise<string | undefined> {
      const said = `мост Telegram: ${line}`

      try {
        const admitted = await context.session.synthetic({
          sessionID,
          text: said,
          description: said.replace(/\s+/g, " "),
          resume: false,
        })

        return admitted.id
      } catch (failure) {
        note(`${sessionID}: владельцу о мосте не сказано: ${reason(failure)}`)

        return undefined
      }
    }

    /** tell говорит владельцу о мосте в самой сессии, не дожидаясь, пока строка ляжет. */
    function tell(sessionID: string, line: string): void {
      void notices.carry(sessionID, () => post(sessionID, line))
    }

    /** once говорит владельцу о мосте по разу на сессию: повторять одно и то же незачем. */
    function once(sessionID: string, line: string): void {
      if (told.has(sessionID)) {
        return
      }

      told.add(sessionID)
      note(`${sessionID}: ${line}`)
      tell(sessionID, line)
    }

    /**
     * word подаёт слово владельца новым ходом. Доставка `queue`: слово владельца ждёт старта нового
     * хода и занятый ход не подруливает — в терминале его ввод тоже не перебивает идущую работу.
     * Одно исключение — строка моста этой сессии ещё лежит в ящике, а хода нет: тогда `steer`, иначе
     * ход вынул бы одну строку моста, а слово увидел бы только следующим ходом (`notice.ts`).
     * Строка, которая ещё в пути, слово задерживает: оно встаёт в ящик после неё. Ход плагин видит
     * потоком событий, и окна, в которых слово всё же уходит `steer` в идущий ход (ход начат из TUI
     * или до перезагрузки плагина, а событие начала ещё не пришло), названы в шапке `notice.ts`.
     *
     * Ход этим не держится: подача зовётся из чтения доставок, а не из обработчика хода, и
     * разрешается она приёмом записи в ящик сессии — после него сессия просыпается сама.
     */
    async function word(sessionID: string, text: string): Promise<Taken> {
      try {
        await notices.settled(sessionID)
        await context.session.prompt({
          sessionID,
          text,
          delivery: notices.choose(sessionID),
        })

        return accepted
      } catch (failure) {
        return rejected(`подача не прошла: ${reason(failure)}`)
      }
    }

    /**
     * command исполняет команду из темы вызовом, равным набору команды владельцем. Имён и смысла
     * команд плагин не знает: белого списка здесь нет, незнакомую команду назовёт сам клиент, и его
     * ответ владелец увидит отметкой на своём сообщении.
     */
    async function command(sessionID: string, name: string, args: string): Promise<Taken> {
      try {
        await context.session.command({ sessionID, name, text: args, delivery: "queue" })

        return accepted
      } catch (failure) {
        return rejected(`команда не исполнилась: ${reason(failure)}`)
      }
    }

    /** deliver исполняет разводку доставки: решение принимает `plan`, вызовы клиента — здесь. */
    function deliver(sessionID: string): (event: Linked) => Promise<Taken> {
      return async (event: Linked) => {
        const todo = plan(event)

        switch (todo.act) {
          case "word":
            return await word(sessionID, todo.text)
          case "command":
            return await command(sessionID, todo.name, todo.args)
          case "refuse":
            return rejected(todo.detail)
        }
      }
    }

    /** drop снимает соединение с учёта: дальше оно либо гаснет, либо прощается со службой. */
    function drop(sessionID: string): SessionLink | undefined {
      const one = held.get(sessionID)

      held.delete(sessionID)
      holders().delete(sessionID)

      return one?.link
    }

    /**
     * room освобождает место под новое соединение. Снимается только то, что по свежести уже за
     * порогом, то есть брошенная сессия: канал живой сессии предел не отбирает — у мода такого
     * случая нет вовсе, и это была бы ровно та разница, которую владелец чувствует.
     */
    function room(): boolean {
      if (held.size < links) {
        return true
      }

      const oldest = stalest(held)
      if (oldest === undefined || oldest.seen >= Date.now() - revive) {
        return false
      }

      drop(oldest.id)?.stop()

      // Сессия брошена дольше порога, но сказать о снятии канала всё равно надо: вернётся к ней
      // владелец — увидит, что было, и канал встанет сам, первым же её событием. Сохранность темы
      // здесь не обещается: похороненная сессия тему не занимает, и за это время её может забрать
      // другая сессия того же дерева, попросив режим под тем же именем. Случится это — скажет
      // `greeted`, а обещать сохранность заранее значило бы врать в половине случаев.
      once(
        oldest.id,
        `канал этой сессии снят: держим не больше ${links.toString()} соединений, а в ней не ` +
          `работали дольше ${hours} ч. Поработай в ней — канал встанет сам`,
      )

      return true
    }

    /**
     * attend поднимает соединение сессии; у поднятого — обновляет время последней работы. `at` —
     * когда сессию трогали: поднятым со старта оно их настоящее время, иначе вытеснение считало бы
     * самой старой ту, которую подняли первой, то есть самую свежую по работе. `title` — название
     * чата из записи сессии: имя темы без аргумента служба берёт из него.
     */
    function attend(sessionID: string, at = Date.now(), title = ""): void {
      const one = held.get(sessionID)
      if (one !== undefined) {
        one.seen = Math.max(one.seen, at)

        return
      }

      // Сессию уже держит другой экземпляр плагина в этом процессе: второго держателя у неё не
      // бывает, и забирать её у живого держателя незачем.
      if (holders().has(sessionID)) {
        note(`${sessionID}: соединение не поднимаем — сессию держит другой экземпляр плагина`)

        return
      }

      // Прошлая попытка кончилась смертью подкоманды, и пауза ещё не вышла. Без неё соединение
      // поднималось бы не первым событием сессии, а каждым, а их у работающей сессии десятки в
      // секунду: там, где подкоманда умирает мгновенно (нет бинаря, нет настроек, вытеснение
      // вторым сервером в той же папке), вышла бы петля спавна.
      if (waiting(failed.get(sessionID), Date.now(), pause)) {
        return
      }

      if (!room()) {
        once(
          sessionID,
          `канала у этой сессии нет: держим не больше ${links.toString()} соединений, и во всех ` +
            `работали свежее ${hours} ч. Освободится одно — канал встанет сам`,
        )

        return
      }

      const link = new SessionLink(sessionID, {
        deliver: deliver(sessionID),
        // Слово владельцу о пропавшем канале идёт через `once`, а не прямым `tell`: свой счёт
        // сказанного у каждого `SessionLink` чистый, и на прямом вызове владелец получал бы одно
        // и то же сообщение на каждую попытку соединения.
        speak: (line: string) => once(sessionID, line),
        opened: (event: Linked) => greeted(sessionID, event),
        ended: (how: string, again: boolean) => {
          // Подкоманда вышла сама: дальше сервер живёт, а запись о сессии держала бы мёртвый
          // процесс и занимала место в пределе. Снимаем её с учёта и запоминаем время неудачи —
          // новая попытка пойдёт не раньше паузы. Потерю связи со службой подкоманда переживает
          // сама, поэтому её конец — отказ службы, после которого звонить незачем, или смерть
          // процесса: тогда соединение поднимается заново после паузы, не дожидаясь события
          // сессии, — у сессии, где владелец не работает, его может не быть часами.
          const seen = held.get(sessionID)?.seen ?? Date.now()

          drop(sessionID)
          failed.set(sessionID, Date.now())
          note(`${sessionID}: соединение снято с учёта, ${how}`)

          if (again) {
            respawn(sessionID, seen)
          }
        },
      })

      holders().add(sessionID)
      held.set(sessionID, { link, seen: at })
      link.start()

      // Название чата уходит службе первым же готовым входом: у поднятой со старта сессии оно
      // уже в её записи, и ждать переименования незачем.
      link.title(title)
    }

    /**
     * greeted читает ответ службы на приветствие. Отметка «владельцу уже сказано» снимается здесь,
     * а не на попытке соединения: снятая на попытке, она пускала бы одно и то же сообщение в сессию
     * каждым спавном.
     *
     * Здесь же владелец узнаёт о потере темы. Похороненная сессия тему не занимает, и первая же
     * сессия того же дерева, попросившая режим под тем же именем, забирает её вместе с режимом.
     * Молчать об этом нельзя: слово владельца в ту тему к этой сессии больше не придёт, а видно
     * это было бы только тишиной.
     */
    function greeted(sessionID: string, event: Linked): void {
      const was = modes.get(sessionID)

      failed.delete(sessionID)
      told.delete(sessionID)
      modes.set(sessionID, event.mode === "on")

      if (!lost(was, event.mode, event.topic_name)) {
        return
      }

      once(
        sessionID,
        "режима и темы у этой сессии больше нет: её тему занял кто-то другой, пока канала не " +
          "было. Слово из прежней темы к ней не придёт — верни режим `/away`, когда понадобится",
      )
    }

    /** release говорит службе, что сессии не стало: её удалил владелец. */
    async function release(sessionID: string): Promise<void> {
      const link = drop(sessionID)

      forgetRevival(sessionID)
      strangers.delete(sessionID)
      told.delete(sessionID)
      failed.delete(sessionID)
      modes.delete(sessionID)
      notices.forget(sessionID)

      await link?.farewell()
    }

    /**
     * relocate снимает решение «своя или чужая»: сессия переехала в другую папку. Без этого
     * переехавшая к нам сессия навсегда осталась бы в чужих, а уехавшая — в держимых.
     */
    async function relocate(sessionID: string): Promise<void> {
      strangers.delete(sessionID)
      forgetRevival(sessionID)
      drop(sessionID)?.stop()

      note(`${sessionID}: сессия переехала, решаем заново`)

      await consider(sessionID)
    }

    /** own — своя ли плагину эта сессия: корневая и этой папки. */
    function own(info: sessionInfo): boolean {
      return info.parentID === undefined && samePath(info.location.directory, here)
    }

    /**
     * consider решает, держать ли соединение этой сессии. Дочерние сессии агентов и сессии другой
     * папки отсеиваются до переезда: роль сессии у них не бывает, а двух держателей у одной сессии
     * протокол не допускает — второй вытеснил бы первого.
     */
    async function consider(sessionID: string): Promise<void> {
      if (held.has(sessionID)) {
        attend(sessionID)

        return
      }

      if (strangers.has(sessionID)) {
        return
      }

      let info: sessionInfo

      try {
        info = await context.session.get({ sessionID })
      } catch (failure) {
        note(`${sessionID}: сессия не прочитана: ${reason(failure)}`)

        return
      }

      if (!own(info)) {
        strangers.add(sessionID)
        note(
          `${sessionID}: соединение не поднимаем — ` +
            (info.parentID === undefined ? `сессия папки ${info.location.directory}` : "дочерняя сессия агента"),
        )

        return
      }

      attend(sessionID, Date.now(), info.title ?? "")
    }

    /**
     * roots читает корневые сессии этой папки страницами. Порядок, в котором их отдаёт список,
     * клиент не обещает ни одним полем своей записи, поэтому отбор по свежести делается самим
     * плагином, а страницы читаются до конца — предел просмотра назван и слышен строкой.
     */
    async function roots(): Promise<Array<sessionInfo & { readonly id: string }>> {
      const found: Array<sessionInfo & { readonly id: string }> = []
      let cursor: string | undefined

      while (found.length < scan) {
        let page: {
          readonly data: ReadonlyArray<sessionInfo & { readonly id: string }>
          readonly cursor: { readonly next?: string | null }
        }

        try {
          page = await context.session.list({
            directory: here,
            parentID: null,
            archived: false,
            limit: PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          })
        } catch (failure) {
          note(`список сессий не прочитан: ${reason(failure)}`)

          return found
        }

        found.push(...page.data)

        const next = page.cursor.next
        if (next === undefined || next === null || page.data.length === 0) {
          return found
        }

        cursor = next
      }

      note(`список сессий просмотрен на ${scan.toString()} записей и оборван: сессии старше могли не попасть`)

      return found
    }

    /**
     * recent поднимает соединения сессий, в которых владелец работал: так канал возвращается после
     * перезапуска сервера OpenCode, не дожидаясь, пока владелец снова прикоснётся к сессии.
     * Свежесть считается здесь, а не берётся порядком списка.
     */
    async function recent(): Promise<void> {
      const edge = Date.now() - revive
      const fresh = (await roots())
        .filter((info) => own(info) && touched(info) >= edge)
        .sort((left, right) => touched(right) - touched(left))

      for (const info of fresh.slice(0, links)) {
        attend(info.id, touched(info), info.title ?? "")
      }

      if (fresh.length > links) {
        note(
          `свежих сессий ${fresh.length.toString()}, а соединений держим ${links.toString()}: ` +
            "остальным канал встанет, когда освободится место",
        )
      }
    }

    /**
     * watch держит подписку на события сервера: сессия родилась — соединение поднимается, сессию
     * удалили — служба слышит `bye`, сессия переехала — решение о ней снимается, сессия поработала
     * — её соединение считается свежим.
     */
    async function watch(): Promise<void> {
      for await (const event of context.event.subscribe({ signal: stop.signal })) {
        const data = event.data as { sessionID?: string } | undefined
        const sessionID = data?.sessionID

        if (sessionID === undefined) {
          continue
        }

        if (event.type === "session.deleted") {
          await release(sessionID)

          continue
        }

        if (event.type === "session.moved") {
          await relocate(sessionID)

          continue
        }

        // Название чата поменялось: тема следует за ним, а держит её служба. Событие приходит на
        // каждое переименование, в том числе когда владелец не у компьютера, — ждать его слова не
        // надо. Название называется соединению сессии: своей темы у плагина нет.
        if (event.type === "session.renamed") {
          const renamed = event.data as { title?: string }
          held.get(sessionID)?.link.title(renamed.title ?? "")
        }

        await consider(sessionID)

        // Запись ящика вынута ходом или отменена: строка моста, если это она, больше не лежит.
        const inboxID = taken(event.type, event.data)
        if (inboxID !== undefined) {
          notices.delivered(sessionID, inboxID)
        }

        const edge = bound(event.type)

        if (edge === "start") {
          notices.started(sessionID)
        } else if (edge === "end") {
          notices.ended(sessionID)
        }

        const said = spoken(event.type, event.data)

        if (edge === undefined && said === undefined) {
          continue
        }

        const linked = held.get(sessionID)
        if (linked === undefined) {
          continue
        }

        // Дописанная реплика агента уходит в тему целиком и одним сообщением. Дочерние сессии
        // агентов сюда не попадают: соединения им плагин не держит, и события их сессий проходят
        // мимо — в теме владелец видит работу самой сессии, как и у мода Claude Code.
        if (said !== undefined) {
          linked.link.message(said)
        }

        // Границы хода: пока ход идёт, служба держит в теме действие чата «печатает» — живость
        // сессии владелец видит им, и в истории темы оно не остаётся. Извещение идёт тем же
        // местным входом подкоманды, что у мода Claude Code: дорога до службы у клиентов одна.
        if (edge === "start") {
          linked.link.turnStart()
        } else if (edge === "end") {
          linked.link.turnEnd()
        }
      }

      // Конец потока без отказа: дальше плагин не поднимает соединения новым сессиям и не считает
      // свежесть старым, то есть половина его работы кончилась. Молчать об этом нельзя.
      if (!stop.signal.aborted) {
        note("поток событий кончился: новые сессии канала не получат, пока плагин не перезагрузят")
      }
    }

    // Вопрос с вариантами в режиме «не у компьютера» уходит в тему, как у Claude Code хуком
    // `AskUserQuestion`: в тему или в диалог, решает подкоманда `hook ask` по режиму сессии у службы.
    // Ушёл в тему — вызов инструмента кончается ошибкой с причиной, и модель знает, что ответ придёт
    // новым ходом; остался диалогом — обработчик ничего не меняет.
    await context.tool.hook("execute.before", async (call) => {
      if (call.tool !== QUESTION_TOOL || !claim(call.sessionID, call.messageID, call.id)) {
        return
      }

      const result = await ask(call.sessionID, call.input)

      if (result.act === "refuse") {
        throw new Error(result.reason)
      }
    })

    // Команды режима: `/away [имя темы]` и `/here`. Id сессии — из самого вызова команды, а не из
    // окружения: у сервера OpenCode окружение одно на все сессии. Исход — строкой моста в сессии.
    // Своего задания модели у команды нет: для модели режим прозрачен, включён он или нет.
    //
    // Реестр команд сервера — словарь по имени: одноимённая команда следующей копии плагина заменяет
    // прежнюю, и вызывается всегда одна. Поэтому реестра вызовов, как у вопроса, командам не нужно —
    // да и ключа у него не было бы: у вызова команды нет своего id, а два одинаковых `/away` подряд —
    // законные два вызова.
    await context.command.transform((commands) => {
      commands.add({
        name: "away",
        description: "Telegram: режим «не у компьютера» — реплики и вопросы сессии идут в тему",
        // Строка исхода в пути с самого начала команды: слово владельца, придержанное до режима,
        // служба отдаёт сразу после включения, и оно обязано встать в ящик после строки, а не перед.
        execute: async (call) => {
          await notices.carry(call.sessionID, async () =>
            post(call.sessionID, (await toggle("on", call.sessionID, call.prompt.text)).line),
          )
        },
      })
      commands.add({
        name: "here",
        description: "Telegram: снять режим «не у компьютера» — вопросы снова в окне OpenCode",
        execute: async (call) => {
          await notices.carry(call.sessionID, async () =>
            post(call.sessionID, (await toggle("off", call.sessionID, call.prompt.text)).line),
          )
        },
      })
    })

    void watch().catch((failure: unknown) => {
      if (!stop.signal.aborted) {
        note(`поток событий оборвался: ${reason(failure)}`)
      }
    })

    await recent()

    // Перезагрузка плагина и остановка сервера соединения гасят, но `bye` не говорят: сессия жива,
    // и служба держит её под вопросом отсрочку возврата — новое поколение успевает вернуться.
    // Скажи плагин «прощай», канал умер бы раньше клиента.
    return () => {
      stop.abort()

      for (const sessionID of [...revivals.keys()]) {
        forgetRevival(sessionID)
      }

      for (const sessionID of [...held.keys()]) {
        drop(sessionID)?.stop()
      }
    }
  },
} satisfies Plugin.Plugin
