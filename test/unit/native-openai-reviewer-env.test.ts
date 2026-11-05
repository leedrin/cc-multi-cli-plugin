import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverOpenAIReviewer } from '../../plugins/multi-openai/src/approval.ts';
import { discoverOpenAI } from '../../plugins/multi-openai/src/provider.ts';
import { removeTemporary } from '../temporary.ts';

test('reviewer 401 refresh resolves Codex from discovery context PATH', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openai-reviewer-env-'));
  t.after(() => removeTemporary(root));
  const bin = path.join(root, 'context-bin');
  const home = path.join(root, 'codex-home');
  await mkdir(bin);
  await mkdir(home);
  const authFile = path.join(home, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'old-token', refresh_token: 'fake-refresh', account_id: 'fixture' },
    }),
  );
  const executable = `const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
 if (request.method === 'account/read') {
  const file = path.join(process.env.CODEX_HOME, 'auth.json');
  const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
  auth.tokens.access_token = 'new-token';
  fs.writeFileSync(file, JSON.stringify(auth));
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'seen-env.json'), JSON.stringify({
   hostSentinel: process.env.TEST_HOST_SENTINEL,
   contextMarker: process.env.TEST_CONTEXT_MARKER,
  }));
  console.log(JSON.stringify({id:2,result:{account:{type:'chatgpt'}}}));
 }
});
`;
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'codex-fixture.js'), executable);
    await writeFile(
      path.join(bin, 'codex.cmd'),
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\codex-fixture.js" %*\r\n',
    );
  } else {
    await writeFile(path.join(bin, 'codex'), `#!${process.execPath}\n${executable}`, {
      mode: 0o755,
    });
  }
  let calls = 0;
  const hostSentinel = 'native-openai-reviewer-env-host-sentinel';
  const previousSentinel = process.env.TEST_HOST_SENTINEL;
  try {
    process.env.TEST_HOST_SENTINEL = hostSentinel;
    const discovery = await discoverOpenAI(
      {
        cwd: root,
        env: {
          CODEX_HOME: home,
          PATH: bin,
          TEST_CONTEXT_MARKER: 'context-only-marker',
        },
        explicit: true,
        log: () => {},
      },
      {
        discoverReviewer: (file, _fetchImpl, options) =>
          discoverOpenAIReviewer(
            file,
            async () => {
              calls++;
              return calls === 1
                ? new Response('', { status: 401 })
                : Response.json({ models: [{ slug: 'codex-auto-review' }] });
            },
            options,
          ),
      },
    );
    assert.deepEqual(discovery, { codexSignedIn: true, openaiReview: true });
    assert.equal(calls, 2);
    const saved = JSON.parse(await readFile(authFile, 'utf8'));
    assert.equal(saved.tokens.access_token, 'new-token');
    const seenEnv = JSON.parse(await readFile(path.join(home, 'seen-env.json'), 'utf8'));
    assert.equal(seenEnv.hostSentinel, undefined);
    assert.equal(seenEnv.contextMarker, 'context-only-marker');
  } finally {
    if (previousSentinel === undefined) {
      delete process.env.TEST_HOST_SENTINEL;
    } else {
      process.env.TEST_HOST_SENTINEL = previousSentinel;
    }
  }
});
