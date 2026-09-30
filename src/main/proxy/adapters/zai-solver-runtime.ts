import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import { platform } from 'os'

/**
 * Where scripts/zai-captcha/solve.py lives and which Python runs it.
 *
 * Both the credential refresh (zai-token-refresh.ts) and the standalone captcha
 * harvest (zai-captcha-solver.ts) launch this same script, so the lookup lives
 * here instead of being duplicated. The duplication was not cosmetic: the
 * captcha path hardcoded `python`/`python3` and froze the script path at import
 * time, so an operator who set ZAI_PYTHON_PATH and ZAI_CAPTCHA_SOLVER_PATH for
 * the refresh path still got a broken interpreter on the captcha path.
 */

/** Where the script lives inside the published Docker image. */
const CONTAINER_SOLVER_SCRIPT = '/app/scripts/zai-captcha/solve.py'

/** Repo-relative location, used by the container, the dev app and the checkout. */
const SOLVER_RELATIVE_PARTS = ['scripts', 'zai-captcha', 'solve.py'] as const

/** How far up from the bundle we look for the repo-relative script. */
const MAX_WALK_UP_LEVELS = 6

export type ExistsFn = (path: string) => boolean

/**
 * Read an integer out of the environment without letting a typo reach the child
 * process.
 *
 * `Number('abc')` is NaN, and NaN used to travel all the way into
 * `--wait-seconds NaN` (argparse `int` then dies with a traceback that reads
 * like a dead account) or into `execFile({ timeout: NaN })`. Values outside the
 * bounds are clamped rather than discarded so `ZAI_REFRESH_COOLDOWN_MS=0` still
 * means "disabled" instead of silently becoming the default.
 */
export function resolveEnvInt(
  raw: string | undefined,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number {
  const text = (raw ?? '').trim()
  const parsed = text ? Number(text) : Number.NaN
  let value = Number.isFinite(parsed) ? Math.floor(parsed) : fallback
  if (bounds.min !== undefined && value < bounds.min) value = bounds.min
  if (bounds.max !== undefined && value > bounds.max) value = bounds.max
  return value
}

function currentModuleDir(): string {
  // CJS output (vite ssr, electron-vite main) defines __dirname; guard anyway so
  // an ESM bundle cannot throw at import time.
  return typeof __dirname === 'string' ? __dirname : ''
}

/**
 * Every place the solver may live, best first. `ZAI_CAPTCHA_SOLVER_PATH` is
 * trusted outright: if the operator named one they know why.
 */
export function solverScriptCandidates(
  env: Record<string, string | undefined> = process.env,
  moduleDir: string = currentModuleDir(),
  exists: ExistsFn = existsSync
): string[] {
  const explicit = (env.ZAI_CAPTCHA_SOLVER_PATH || '').trim()
  const candidates: string[] = explicit ? [explicit] : []

  candidates.push(CONTAINER_SOLVER_SCRIPT)

  // Packaged desktop app: extraResources keeps the script outside the asar.
  const resourcesPath = (
    env.ELECTRON_RESOURCES_PATH ||
    (typeof process !== 'undefined' ? (process as { resourcesPath?: string }).resourcesPath : '') ||
    ''
  ).trim()
  if (resourcesPath) candidates.push(join(resourcesPath, ...SOLVER_RELATIVE_PARTS))

  // Dev app and server bundle both sit a few levels below the checkout root.
  let dir = moduleDir ? resolvePath(moduleDir) : ''
  for (let level = 0; level < MAX_WALK_UP_LEVELS && dir; level++) {
    candidates.push(join(dir, ...SOLVER_RELATIVE_PARTS))
    const parent = resolvePath(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index)
}

/**
 * First candidate that exists. When none does, the preferred path is returned so
 * the failure still names the location the operator expects (a missing script
 * must not degrade into "python: can't open file ''").
 */
export function solverScriptPath(
  env: Record<string, string | undefined> = process.env,
  moduleDir: string = currentModuleDir(),
  exists: ExistsFn = existsSync
): string {
  const candidates = solverScriptCandidates(env, moduleDir, exists)
  return candidates.find((candidate) => exists(candidate)) || candidates[0] || CONTAINER_SOLVER_SCRIPT
}

/**
 * Interpreters installed under the usual Windows per-user location. The Python
 * that owns PATH is often a different install from the one that has the solver
 * dependencies, so these are worth trying before giving up.
 */
export function windowsPythonInstalls(env: Record<string, string | undefined> = process.env): string[] {
  const roots = [
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Python` : '',
    'C:\\Python',
  ].filter(Boolean)
  const found: string[] = []
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root)) {
        if (!/^Python3\d*$/i.test(entry)) continue
        const exe = `${root}\\${entry}\\python.exe`
        if (existsSync(exe)) found.push(exe)
      }
    } catch {
      // Directory missing or unreadable - nothing to add from here.
    }
  }
  return found
}

/**
 * Candidate interpreters, most likely first. `ZAI_PYTHON_PATH` is trusted
 * outright - if the operator named one, they know what they are doing.
 */
export function pythonCandidates(
  plat: NodeJS.Platform = platform(),
  env: Record<string, string | undefined> = process.env
): string[] {
  const explicit = (env.ZAI_PYTHON_PATH || '').trim()
  if (explicit) return [explicit]
  if (plat === 'win32') return ['python', 'python3', 'py', ...windowsPythonInstalls(env)]
  return ['python3', 'python']
}

export type PythonProbe = (bin: string) => boolean

/**
 * The solver needs patchright (browser), numpy and Pillow (image maths). The
 * first `python` on PATH is frequently some other install that has none of them,
 * and a refresh that dies on ModuleNotFoundError looks identical to a dead
 * account.
 */
export const defaultPythonProbe: PythonProbe = (bin) => {
  try {
    const probe = spawnSync(bin, ['-c', 'import patchright, numpy, PIL'], {
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8',
    })
    return !probe.error && probe.status === 0
  } catch {
    return false
  }
}

let cachedPythonKey: string | null = null
let cachedPythonBin: string | null = null

/**
 * Resolve the interpreter once and remember it: probing spawns a process per
 * candidate, and every refresh would otherwise pay for the whole list. The cache
 * is keyed on the explicit override so a late `ZAI_PYTHON_PATH` (documented as
 * runtime-tunable) is still honoured.
 */
export function resolvePythonBin(
  plat: NodeJS.Platform = platform(),
  env: Record<string, string | undefined> = process.env,
  probe: PythonProbe = defaultPythonProbe
): string {
  const key = (env.ZAI_PYTHON_PATH || '').trim()
  if (cachedPythonBin && cachedPythonKey === key) return cachedPythonBin

  const candidates = pythonCandidates(plat, env)
  let chosen = candidates[0] || 'python'
  if (!key) {
    for (const bin of candidates) {
      if (probe(bin)) {
        chosen = bin
        break
      }
    }
  }

  cachedPythonKey = key
  cachedPythonBin = chosen
  return chosen
}

/** Test seam: forget the interpreter cache between cases. */
export function resetSolverRuntimeForTests(): void {
  cachedPythonKey = null
  cachedPythonBin = null
}
