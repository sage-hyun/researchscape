import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),python=process.env.RESEARCHSCAPE_PYTHON||'python',available=spawnSync(python,['--version'],{windowsHide:true}).status===0;
test('Zotero scan uses a separate snapshot, preserves the source, excludes deleted files and rejects path escape',{skip:!available},async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-zotero-')),storage=path.join(temp,'storage','TEST1234'),cache=path.join(temp,'cache');await fs.mkdir(storage,{recursive:true});await fs.writeFile(path.join(storage,'main.pdf'),'%PDF-fixture');
  const create=`import sqlite3,sys,pathlib
r=pathlib.Path(sys.argv[1]);c=sqlite3.connect(r/'zotero.sqlite')
c.executescript('''CREATE TABLE items(itemID INTEGER,key TEXT,libraryID INTEGER);CREATE TABLE itemAttachments(itemID INTEGER,parentItemID INTEGER,path TEXT,linkMode INTEGER,contentType TEXT);CREATE TABLE fields(fieldID INTEGER,fieldName TEXT);CREATE TABLE itemData(itemID INTEGER,fieldID INTEGER,valueID INTEGER);CREATE TABLE itemDataValues(valueID INTEGER,value TEXT);CREATE TABLE deletedItems(itemID INTEGER);
INSERT INTO items VALUES(1,'ITEM1234',1),(2,'TEST1234',1),(3,'DELETED1',1),(4,'ESCAPED1',1);
INSERT INTO itemAttachments VALUES(2,1,'storage:main.pdf',1,'application/pdf'),(3,1,'storage:gone.pdf',1,'application/pdf'),(4,1,'storage:../../outside.pdf',1,'application/pdf');
INSERT INTO fields VALUES(1,'title'),(2,'DOI');INSERT INTO itemDataValues VALUES(1,'A Specific Motion Representation Learning Research Paper'),(2,'10.1234/fixture');INSERT INTO itemData VALUES(1,1,1),(1,2,2);INSERT INTO deletedItems VALUES(3);''');c.commit();c.close()`;
  try{
    const made=spawnSync(python,['-c',create,temp],{encoding:'utf8',windowsHide:true});assert.equal(made.status,0,made.stderr);const before=await fs.readFile(path.join(temp,'zotero.sqlite')),pdfBefore=await fs.readFile(path.join(storage,'main.pdf'));
    const result=spawnSync(python,[path.join(root,'scripts','zotero-library.py'),'--root',temp,'--cache',cache],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);const d=JSON.parse(result.stdout);
    assert.equal(d.total,2);assert.equal(d.available,1);const main=d.records.find(r=>r.attachmentKey==='TEST1234');assert.equal(main.doi,'10.1234/fixture');assert.equal(main.itemKey,'ITEM1234');assert.equal(main.exists,true);
    const escaped=d.records.find(r=>r.attachmentKey==='ESCAPED1');assert.equal(escaped.path,null);assert.equal(escaped.exists,false);assert.ok(!d.records.some(r=>r.attachmentKey==='DELETED1'));
    assert.deepEqual(await fs.readFile(path.join(temp,'zotero.sqlite')),before);assert.deepEqual(await fs.readFile(path.join(storage,'main.pdf')),pdfBefore);assert.ok(await fs.stat(path.join(cache,'zotero-snapshot.sqlite')));
  }finally{assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(temp,{recursive:true,force:true});}
});
