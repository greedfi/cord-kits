import path from 'node:path'

export function dataDirectory(env = process.env, cwd = process.cwd()) {
  if (env.DATA_DIR && env.DATA_DIR.trim()) return path.resolve(env.DATA_DIR)
  return path.join(cwd, 'data')
}

export function dataPaths(env = process.env, cwd = process.cwd()) {
  const root = dataDirectory(env, cwd)
  return {
    root,
    lock: path.join(root, 'instance.lock'),
    store: path.join(root, 'panels.json'),
  }
}
