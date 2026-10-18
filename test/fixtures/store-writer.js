import { createStore } from '../../lib/host/store.js';

const [root, serialized] = process.argv.slice(2);
process.once('message', async () => {
  const result = await createStore({ root }).saveReview(JSON.parse(serialized));
  process.send(result, () => process.disconnect());
});
process.send('ready');
