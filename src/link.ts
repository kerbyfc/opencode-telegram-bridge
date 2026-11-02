// Соединение сессии со службой моста: ровно то же, чем держит его мод Claude Code, — подкоманда
// `telegram-bridge link`. Доставку она отдаёт строкой JSON своей стандартной выдачи, подтверждение
// приёма, границы хода и конец сессии принимает коротким запросом на свой сокет,
// адрес которого называет событием `ready`. Протокол, курсор `after`, повторное соединение и
// отказы, после которых канала нет, живут в ней, а не здесь: сторона OpenCode от стороны Claude
// Code отличается только тем, чем подаётся слово владельца.

import { spawn, type ChildProcessByStdio } from "node:child_process"
import http from "node:http"
import type { Readable } from "node:stream"

import { binary, note, reason } from "./bridge.ts"

/** Пути местного входа подкоманды — по одному на операцию. Те же пути зовёт мод Claude Code. */
const PATH_ACK = "/ack"
const PATH_BYE = "/bye"
const PATH_TURN_START = "/turn/start"
const PATH_TURN_END = "/turn/end"
const PATH_MESSAGE = "/message"
const PATH_NAME = "/name"

/** Исход подачи доставки в сессию: честь или придержанное слово. */
export type Outcome = "accepted" | "rejected"

/** Событие подкоманды `link`: один объект JSON в строке её стандартной выдачи. */
export type Linked = {
  event?: string
  socket?: string
  mode?: string
  topic_id?: number
  topic_name?: string
  revived?: boolean
  kind?: string
  delivery_id?: string
  text?: string
  provenance?: string
  code?: string
}

/** Чем кончилась подача доставки в сессию: исход и причина для журнала службы. */
export type Taken = {
  outcome: Outcome
  detail: string
}

/** Чем плагин отвечает подкоманде: подача доставки и разговор с владельцем. */
export type Handlers = {
  /** deliver подаёт доставку в сессию и отвечает, чем это кончилось. */
  deliver: (delivery: Linked) => Promise<Taken>
  /** speak говорит владельцу о мосте тем, чем плагин вообще говорит в сессии. */
  speak: (line: string) => void
  /**
   * ended — соединение кончилось само: подкоманда вышла. Зовётся он только там, где конец не по
   * слову плагина, и нужен потому, что сервер OpenCode живёт дальше: без него запись о сессии
   * осталась бы с мёртвым процессом внутри, заняв место в пределе соединений навсегда.
   */
  ended?: (how: string) => void
  /** opened называет режим и тему, как их назвала служба ответом на приветствие. */
  opened?: (event: Linked) => void
}

/**
 * SessionLink — соединение одной сессии. Своё у него два: дочерний процесс подкоманды и адрес её
 * местного входа. Решений о самом слове владельца оно не принимает — это дело подачи.
 */
export class SessionLink {
  private readonly session: string
  private readonly handlers: Handlers

  /** Вход подкоманде не нужен: доставку она отдаёт выдачей, а короткий запрос идёт в её сокет. */
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined
  /** Адрес местного входа подкоманды, как она назвала его событием `ready`. */
  private front: string | undefined
  /** Владельцу о пропавшем канале уже сказано: второй раз одно и то же не говорится. */
  private spoken = false
  /** Конец соединения сказан самим плагином: о нём владельцу говорить нечего. */
  private farewelled = false
  /** Незакрытый хвост стандартной выдачи: строки читаются по одной. */
  private rest = ""
  /**
   * Очередь разбора: куски выдачи приходят, пока прежний разбор ждёт подачу, и без очереди строки
   * двух кусков разбирались бы вперемешку. Отказ разбора снимается здесь же — необработанный он
   * уносит весь процесс сервера OpenCode, а не одну сессию.
   */
  private parsing: Promise<void> = Promise.resolve()
  /**
   * Счёт ходов сессии: им назван ход на обеих своих границах. Своего id хода сервер OpenCode в
   * событиях не называет, а имя нужно для порядка — извещения ответа не ждут, и конец прошлого
   * хода может прийти после начала следующего. Счёт свой у каждого соединения: сессия у него
   * одна, и большего от имени не требуется — служба сверяет его с тем, что держит сама.
   */
  private turn = 0
  /**
   * Название чата, каким его назвал сервер, и то, какое название уже ушло службе на этом
   * соединении. Имя темы без аргумента служба берёт из него, а меняется оно — тема
   * переименовывается.
   */
  private chat = ""
  private named = ""

  constructor(session: string, handlers: Handlers) {
    this.session = session
    this.handlers = handlers
  }

  /**
   * start поднимает соединение сессии. Клиент назван явно, сессия — ключом: id сессии кладёт
   * плагин, и из окружения служба его не выводит ни под каким видом.
   */
  start(): void {
    const child = spawn(binary(), ["link", "--session", this.session, "--client", "opencode"], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    this.child = child

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      this.parsing = this.parsing
        .then(() => this.read(chunk))
        .catch((failure: unknown) => {
          note(`${this.session}: разбор выдачи соединения упал: ${reason(failure)}`)
        })
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => note(`${this.session}: ${chunk.trimEnd()}`))
    child.on("error", (failure) => {
      this.said(`соединение со службой не поднялось: ${reason(failure)}`)
    })
    child.on("close", (code, signal) => {
      const how = signal === null ? `код ${String(code)}` : `сигнал ${signal}`
      const ours = this.farewelled

      this.child = undefined

      note(`${this.session}: соединение со службой кончилось, ${how}`)

      if (ours) {
        return
      }

      // Конец не по слову плагина значит, что канала больше нет: бинаря нет в `PATH`, настройки
      // не названы, служба отказала чужой версией контракта, процесс убит. Молчать об этом нельзя
      // — в теме владелец увидит только отметку придержанного на своём сообщении, а причина
      // здесь.
      if (!this.spoken) {
        this.said(`канала нет, соединение кончилось (${how})`)
      }

      this.handlers.ended?.(how)
    })
  }

  /**
   * stop гасит соединение, ничего не говоря службе. Сессию это не хоронит: служба держит её под
   * вопросом отсрочку возврата, и новое поколение плагина успевает вернуться. Так гасится
   * перезагрузка плагина и вытеснение заброшенной сессии.
   */
  stop(): void {
    this.farewelled = true
    this.child?.kill()
    this.child = undefined
  }

  /** turnStart: ход сессии начался — пока он идёт, служба держит в теме «печатает». */
  turnStart(): void {
    this.turn += 1
    this.tell(PATH_TURN_START, { turn: String(this.turn) })
  }

  /**
   * turnEnd: ход сессии кончился — действие чата гаснет. Называется тот же ход, что и на начале:
   * конец, обогнавший начало следующего хода, служба по этому имени пропустит мимо.
   */
  turnEnd(): void {
    this.tell(PATH_TURN_END, { turn: String(this.turn) })
  }

  /**
   * message отдаёт службе дописанную реплику агента: в тему она уходит целиком и одним сообщением,
   * а длинную служба режет по пределу сама. Ход сессии этим не держится — извещение уходит без
   * ожидания, как границы хода.
   */
  message(text: string): void {
    this.tell(PATH_MESSAGE, { text })
  }

  /**
   * title называет службе название чата — имя темы без аргумента служба берёт из него. Пустое
   * название не называется: у чата его нет, и прежнее имя темы остаётся.
   *
   * Название запоминается до входа соединения: `attend` поднимает соединение, когда название уже
   * известно из записи сессии, а `ready` приходит позже — отдать его раньше некуда.
   */
  title(value: string): void {
    const name = value.trim()

    if (name === "") {
      return
    }

    this.chat = name
    this.speak()
  }

  /** speak называет службе запомненное название, если на этом входе оно ещё не названо. */
  private speak(): void {
    if (this.front === undefined || this.chat === "" || this.chat === this.named) {
      return
    }

    this.named = this.chat
    this.tell(PATH_NAME, { name: this.chat })
  }

  /**
   * farewell говорит службе, что сессия кончилась, и гасит соединение. Зовётся он там, где сессии
   * действительно не стало: хоронит её служба сама, и в тему о этом не пишется ничего.
   */
  async farewell(): Promise<void> {
    this.farewelled = true

    if (this.front !== undefined) {
      try {
        await this.post(PATH_BYE, {})
      } catch (failure) {
        note(`${this.session}: конец сессии службе не сказан: ${reason(failure)}`)
      }
    }

    this.child?.kill()
    this.child = undefined
  }

  /**
   * tell извещает службу. Ответа извещения по контракту не ждут, поэтому ход ими не держится:
   * отказ уезжает строкой в поток ошибок сервера, а работу сессии не рвёт. Входа ещё нет — звать
   * некуда, и это не отказ: границу назовёт следующий ход, реплику — следующая реплика.
   */
  private tell(path: string, body: Record<string, string>): void {
    if (this.front === undefined) {
      return
    }

    void this.post(path, body)
      .then((answered) => {
        if (!answered.ok) {
          note(`${this.session}: ${path}: служба отказала ${answered.status} ${answered.body}`)
        }
      })
      .catch((failure: unknown) => {
        note(`${this.session}: ${path} не дошёл: ${reason(failure)}`)
      })
  }

  /** read разбирает кусок стандартной выдачи на строки: пустых строк в ней нет. */
  private async read(chunk: string): Promise<void> {
    this.rest += chunk

    const lines = this.rest.split("\n")
    this.rest = lines.pop() ?? ""

    for (const line of lines) {
      if (line.trim() !== "") {
        await this.take(line)
      }
    }
  }

  /** take разбирает одну строку выдачи подкоманды. */
  private async take(line: string): Promise<void> {
    let event: Linked

    try {
      event = JSON.parse(line) as Linked
    } catch (failure) {
      note(`${this.session}: строка соединения не разобрана: ${reason(failure)}`)

      return
    }

    switch (event.event) {
      case "ready":
        this.front = event.socket
        this.handlers.opened?.(event)
        // Название, запомненное до входа, уходит службе сразу: иначе имя темы без аргумента
        // пришлось бы ждать переименования чата, а его может не быть вовсе.
        this.named = ""
        this.speak()
        note(`${this.session}: соединение со службой открыто, режим ${event.mode ?? "?"}`)

        return
      case "delivery":
        return await this.hand(event)
      case "error":
        // Отказ, после которого канала нет: чужая версия контракта или вытеснённое соединение.
        // Владелец узнаёт о нём в терминале, а не по пропавшему каналу.
        this.said(event.text ?? "служба отказала")

        return
      default:
        note(`${this.session}: событие соединения ${event.event ?? "?"}: ${event.text ?? ""}`)
    }
  }

  /** hand подаёт доставку в сессию и подтверждает приём: честь ставит подтверждение, не выдача. */
  private async hand(event: Linked): Promise<void> {
    const taken = await this.handlers.deliver(event)

    await this.confirm(event.delivery_id ?? "", taken)
  }

  /**
   * confirm подтверждает приём доставки. Отказ подтверждения — рабочее состояние протокола, а не
   * исключение: рвать им единственный цикл чтения доставок нельзя.
   */
  private async confirm(delivery: string, taken: Taken): Promise<void> {
    if (this.front === undefined) {
      this.said(`приём ${delivery} подтверждать некуда: соединение не назвало свой вход`)

      return
    }

    try {
      const answered = await this.post(PATH_ACK, {
        delivery_id: delivery,
        outcome: taken.outcome,
        detail: taken.detail,
      })

      if (!answered.ok) {
        // Служба отказала: слово владельца осталось придержанным, и он видит это отметкой
        // придержанного на своём сообщении. О конце самого соединения скажет событие `error` — оно
        // идёт тем же отказом.
        note(`${this.session}: приём ${delivery} не подтверждён: ${answered.status} ${answered.body}`)
      }
    } catch (failure) {
      this.said(`приём ${delivery} не дошёл, канала нет: ${reason(failure)}`)
    }
  }

  /** post зовёт местный вход подкоманды: HTTP поверх её сокета. */
  private post(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: string }> {
    const socket = this.front
    if (socket === undefined) {
      throw new Error("местного входа соединения нет: `ready` не пришёл")
    }

    const payload = JSON.stringify(body)

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: socket,
          path,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (response) => {
          let text = ""

          response.setEncoding("utf8")
          response.on("data", (piece: string) => {
            text += piece
          })
          response.on("end", () => {
            const status = response.statusCode ?? 0

            resolve({ ok: status >= 200 && status < 300, status, body: text })
          })
        },
      )

      request.on("error", reject)
      request.end(payload)
    })
  }

  /**
   * said говорит владельцу о мосте один раз: дальше канала всё равно нет, и второй раз одно и то
   * же не повторяется.
   */
  private said(line: string): void {
    this.spoken = true

    note(`${this.session}: ${line}`)
    this.handlers.speak(line)
  }
}
