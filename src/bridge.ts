// Общее для обеих половин плагина: как зовётся бинарь моста, куда уходят строки о его жизни и чья
// копия плагина — из какого дерева. Путей внутри состояния моста плагин не знает ни одного — он
// зовёт подкоманды.

import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Имя бинаря моста в `PATH`. Путь к нему перебивает переменная окружения `DM_TELEGRAM_BRIDGE`;
 * имя переменной пишется литералом в месте чтения, как у мода Claude Code.
 */
const BINARY = "telegram-bridge"

/** binary — чем звать мост: названный путь или имя в `PATH`. */
export function binary(): string {
  const named = process.env.DM_TELEGRAM_BRIDGE

  return named !== undefined && named !== "" ? named : BINARY
}

/**
 * settingsPath называет путь к настройкам службы: `DM_TELEGRAM_CONFIG`, а если он не назван —
 * `~/.telegram-bridge/config.yaml`, когда файл есть. Без пути `telegram-bridge link` выходит с
 * кодом 2, и канал не поднимается.
 */
export function settingsPath(
  named: string | undefined,
  home: string,
  exists: (path: string) => boolean,
): string | undefined {
  if (named !== undefined && named !== "") {
    return named
  }

  const fallback = path.join(home, ".telegram-bridge", "config.yaml")

  return exists(fallback) ? fallback : undefined
}

/** adoptSettings кладёт найденный путь в окружение: его наследует каждая подкоманда моста. */
export function adoptSettings(): void {
  const found = settingsPath(process.env.DM_TELEGRAM_CONFIG, homedir(), existsSync)

  if (found !== undefined) {
    process.env.DM_TELEGRAM_CONFIG = found
  }
}

/**
 * note пишет строку о жизни соединения в поток ошибок сервера OpenCode. В тему служебных строк о
 * жизни сессии не уходит ни одной, а владельцу о пропавшем канале говорит сам плагин.
 */
export function note(line: string): void {
  process.stderr.write(`[telegram-bridge] ${line}\n`)
}

/** reason называет причину отказа строкой, годной для журнала службы. */
export function reason(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** numeric читает число из окружения; негодное значение — отказ, а не тихая подмена своим. */
export function numeric(name: string, fallback: number): number {
  const named = process.env[name]
  if (named === undefined || named === "") {
    return fallback
  }

  const value = Number(named)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}=${named}: ждали положительное число`)
  }

  return value
}

/** Разобранные пути каталогов: разбор ходит на диск, а каталоги в сравнении повторяются. */
const resolved = new Map<string, string>()

/**
 * samePath сверяет два каталога по их настоящему пути. Сравнение строк тут врёт: на macOS `/tmp` —
 * ссылка на `/private/tmp`, и сессия, названная одним путём, выглядела бы чужой плагину, названному
 * другим. Путь, которого уже нет, сверяется как есть — выдумывать ему разбор нечем.
 */
export function samePath(left: string, right: string): boolean {
  return real(left) === real(right)
}

/** real разбирает путь каталога до настоящего, помня разобранное. */
function real(directory: string): string {
  const known = resolved.get(directory)
  if (known !== undefined) {
    return known
  }

  let value = directory

  try {
    value = realpathSync.native(directory)
  } catch {
    // Каталога больше нет: сверяем как есть.
  }

  resolved.set(directory, value)

  return value
}

/** ROOTS — отрезок пути, по которому worktree отличается от основного дерева. */
const ROOTS = `${path.sep}.claude${path.sep}worktrees${path.sep}`

/**
 * pluginRoot отдаёт корень пакета, из которого загружен плагин: `src/<файл>.ts` лежит на уровень
 * ниже него. От дерева сессии плагин ставится отдельно — из Git-адреса в настройках OpenCode, —
 * поэтому своего места в дереве сессии у него нет, и путь считается только от своего файла.
 */
export function pluginRoot(moduleURL: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleURL)), "..")
}

/**
 * repoRoot — репозиторий, в котором лежит каталог, по ответу `git rev-parse --show-toplevel`.
 * Каталог вне репозитория — сам себе репозиторий: без git-корня сессия не становится чужой, и
 * строку внизу окна OpenCode рисует та же копия плагина, что и для сессии в репозитории.
 */
function repoRoot(directory: string): string {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
  const top = String(result.stdout).trim()

  return result.status === 0 && top !== "" ? top : directory
}

/** Деревья, уже сосчитанные: сессия спрашивается на каждой перерисовке, а `git` — не бесплатный. */
const trees = new Map<string, string>()

/**
 * treeRoot отдаёт корень рабочего дерева, к которому относится каталог: у worktree — до
 * `.claude/worktrees/<имя>`, у остального — корень его репозитория. Так подкаталог сессии
 * считается тем же деревом, что и её корень.
 */
export function treeRoot(directory: string): string {
  const key = real(path.resolve(directory))
  const known = trees.get(key)
  if (known !== undefined) {
    return known
  }

  const at = key.indexOf(ROOTS)
  const root = at < 0
    ? repoRoot(key)
    : key.slice(0, at + ROOTS.length + (key.slice(at + ROOTS.length).split(path.sep)[0] ?? "").length)

  trees.set(key, root)

  return root
}

/**
 * pluginID отдаёт id плагина, разный у копий из разных деревьев: сервер поднимает копии одного
 * плагина из нескольких деревьев сразу, и два одинаковых id он считает ошибкой. Копия worktree
 * получает в id имя своего дерева; всякая другая копия — поставленная из Git-адреса — остаётся с
 * базовым id и `git` не зовёт: вне дерева репозитория этого вызова просто нет.
 */
export function pluginID(base: string, root: string): string {
  const at = real(path.resolve(root)).indexOf(ROOTS)
  if (at < 0) {
    return base
  }

  const rest = real(path.resolve(root)).slice(at + ROOTS.length)
  const name = (rest.split(path.sep)[0] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-")

  return name === "" ? base : `${base}.${name}`
}

/**
 * owned отвечает, показывает ли эта копия плагина строку сессии каталога: копия worktree — только
 * сессиям своего дерева, всякая другая — всем сессиям сервера. Второе — обычный случай установки
 * из Git-адреса: копия одна на сервер, и делить сессии ей не с кем.
 */
export function owned(plugin: string, directory: string): boolean {
  return !real(path.resolve(plugin)).includes(ROOTS) || treeRoot(plugin) === treeRoot(directory)
}

