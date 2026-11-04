import { createApp } from './app.factory';
import { ENV, type Env } from './config/env';

void (async () => {
  const app = await createApp();
  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);
  console.log(`herp api listening on :${env.PORT}`);
})();
