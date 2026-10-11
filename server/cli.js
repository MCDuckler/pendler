// Box admin: pair a phone, list or remove devices, send a test push.
//
//   node server/cli.js pair [name]     prints the pendler://pair link to open on the phone
//   node server/cli.js devices
//   node server/cli.js unpair <id>
//   node server/cli.js push-test

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';
import { Watcher } from './src/watch.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const store = new Store(env.DATA_DIR || join(root, '.data'));
const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'pair': {
    const { device, token } = store.pair(args.join(' ') || 'iPhone');
    console.log(`paired ${device.id} (${device.name})`);
    console.log(`pendler://pair?url=${encodeURIComponent(publicUrl)}&token=${token}`);
    break;
  }
  case 'devices':
    for (const d of store.data.devices) {
      console.log(`${d.id}  ${d.name.padEnd(16)} seen ${d.lastSeen || '—'}  profile ${d.profileAt || '—'}  push ${d.notify?.enabled ? `on (${d.notify.leadMin} min)` : 'off'}`);
    }
    break;
  case 'unpair':
    console.log(store.unpair(args[0]) ? 'removed' : 'no such device');
    break;
  case 'push-test':
    await new Watcher({ store, ntfy: { url: env.NTFY_URL, topic: env.NTFY_TOPIC, token: env.NTFY_TOKEN } })
      .push('Pendler', 'Test-Push vom Server', { tags: ['white_check_mark'] });
    console.log('sent');
    break;
  default:
    console.log('usage: cli.js pair [name] | devices | unpair <id> | push-test');
    process.exit(cmd ? 1 : 0);
}
