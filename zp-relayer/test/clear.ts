import compose from 'docker-compose'
import path from 'path'

export async function clear() {
  const cwd = path.join(__dirname)
  console.log('Removing previous deployment...')
  await compose.down({ cwd, commandOptions: ['-v'], log: false })
}

clear()
