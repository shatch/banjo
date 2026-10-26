/**
 * Deploys the phone-line fixtures (#205, fixtures/twilio/*.js) to a Twilio
 * Serverless service, `banjo-fixtures`, in the account in .env. Idempotent:
 * reuses the service, environment and functions, and uploads a new version
 * of each. Prints the domain to set as FIXTURE_FUNCTIONS_DOMAIN.
 *
 *   npm run fixtures:deploy
 *
 * The functions are `protected`: only requests Twilio signed reach them.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import twilio from 'twilio';

const DIR = 'fixtures/twilio';
const SERVICE = 'banjo-fixtures';
const ENVIRONMENT = 'production';

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
const client = twilio(sid, token);
const serverless = client.serverless.v1;

async function uploadVersion(serviceSid: string, functionSid: string, path: string, content: string): Promise<string> {
  const form = new FormData();
  form.append('Path', path);
  form.append('Visibility', 'protected');
  form.append('Content', new Blob([content], { type: 'application/javascript' }), basename(path) + '.js');
  const res = await fetch(`https://serverless-upload.twilio.com/v1/Services/${serviceSid}/Functions/${functionSid}/Versions`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    body: form,
  });
  if (!res.ok) throw new Error(`uploading ${path} failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { sid: string }).sid;
}

async function main(): Promise<void> {
  const services = await serverless.services.list();
  const service = services.find((s) => s.uniqueName === SERVICE) ?? (await serverless.services.create({ uniqueName: SERVICE, friendlyName: 'Banjo phone-line fixtures', includeCredentials: false }));
  const environments = await serverless.services(service.sid).environments.list();
  const environment =
    environments.find((e) => e.uniqueName === ENVIRONMENT) ?? (await serverless.services(service.sid).environments.create({ uniqueName: ENVIRONMENT }));

  const existing = await serverless.services(service.sid).functions.list();
  const versions: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
    const name = basename(file, '.js');
    const fn = existing.find((f) => f.friendlyName === name) ?? (await serverless.services(service.sid).functions.create({ friendlyName: name }));
    versions.push(await uploadVersion(service.sid, fn.sid, `/${name}`, readFileSync(join(DIR, file), 'utf8')));
    console.log(`uploaded /${name}`);
  }

  let build = await serverless.services(service.sid).builds.create({ functionVersions: versions });
  for (let i = 0; i < 60 && build.status !== 'completed' && build.status !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    build = await serverless.services(service.sid).builds(build.sid).fetch();
  }
  if (build.status !== 'completed') throw new Error(`build ${build.sid} ended ${build.status}`);
  await serverless.services(service.sid).environments(environment.sid).deployments.create({ buildSid: build.sid });
  console.log(`deployed. Set in .env: FIXTURE_FUNCTIONS_DOMAIN=${environment.domainName}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
