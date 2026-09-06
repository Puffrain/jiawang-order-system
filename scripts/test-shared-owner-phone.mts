import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jw-role-login-'));
process.env.DATABASE_URL='file:'+path.join(dir,'test.db');
process.env.OWNER_PHONE='13900000001';
process.env.OWNER_PASSWORD=randomUUID();
const {default:db}=await import('../lib/db');
const {ensureOwnerFromEnvironment}=await import('../lib/bootstrap');
const {findActiveOwnerByLoginPhone}=await import('../lib/owner-login');
try {
  assert.equal(ensureOwnerFromEnvironment().ready,true);
  const owner=db.prepare("SELECT id,phone FROM users WHERE role='owner'").get() as {id:string;phone:string};
  db.prepare("INSERT INTO users(id,phone,role,password_hash,display_name) VALUES(?,?,'courier',?,'test')").run('test-courier','13900000002','unchanged');
  process.env.OWNER_PHONE='13900000002';
  assert.equal(ensureOwnerFromEnvironment().ready,true);
  assert.equal(findActiveOwnerByLoginPhone('13900000002')?.id,owner.id);
  assert.equal(ensureOwnerFromEnvironment().ready,true);
  const courier=db.prepare("SELECT role,password_hash hash FROM users WHERE id='test-courier'").get() as {role:string;hash:string};
  assert.deepEqual(courier,{role:'courier',hash:'unchanged'});
  assert.equal((db.prepare('SELECT phone FROM users WHERE id=?').get(owner.id) as {phone:string}).phone,owner.phone);
  console.log('PASS: shared login alias, owner identity, courier credentials, repeated bootstrap');
} finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
