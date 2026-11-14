import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {publicRoutes,requestAccess} from '../lib/request-access.mjs';

const routes=publicRoutes(['https://fixture.tailnet.ts.net/rs/']);
const request=(host,origin,method='POST',extra={})=>({method,headers:{host,...(origin?{origin}:{}),...extra}});
test('only configured proxy hosts and their HTTPS origin bypass local-only checks',()=>{
  assert.deepEqual(requestAccess(request('127.0.0.1:4317','http://127.0.0.1:4317'),routes),{basePath:''});
  assert.deepEqual(requestAccess(request('localhost:4317'),routes),{basePath:''});
  assert.deepEqual(requestAccess(request('[::1]:4317'),routes),{basePath:''});
  assert.deepEqual(requestAccess(request('fixture.tailnet.ts.net','https://fixture.tailnet.ts.net'),routes),{basePath:'/rs'});
  assert.equal(requestAccess(request('fixture.tailnet.ts.net','http://fixture.tailnet.ts.net'),routes).status,403);
  assert.equal(requestAccess(request('fixture.tailnet.ts.net','https://outside.example'),routes).status,403);
  assert.equal(requestAccess(request('fixture.tailnet.ts.net','null'),routes).status,403);
  for(const host of ['outside.example','other.tailnet.ts.net','localhost.evil.example','localhost@outside.example','fixture.tailnet.ts.net:9999']){
    assert.equal(requestAccess(request(host,null,'GET',{'x-forwarded-host':'fixture.tailnet.ts.net','x-forwarded-proto':'https'}),routes).status,403);
  }
  assert.equal(requestAccess(request('fixture.tailnet.ts.net',null,'GET')).status,403);
  for(const value of ['http://fixture.tailnet.ts.net/rs','https://user:pass@example.org/','https://example.org/a?x=1','https://example.org/a#b','https://example.org/a%22'])assert.throws(()=>publicRoutes([value]));
});

test('browser resolves API, PDF, upload, crop and thumbnail paths within the proxy mount',()=>{
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const bootstrap=source.slice(source.indexOf('const appBase='),source.indexOf('const esc='));
  for(const prefix of ['','/rs']){
    const context=vm.createContext({URL,document:{currentScript:{src:`https://fixture.tailnet.ts.net${prefix}/app.js`}}});
    vm.runInContext(bootstrap,context);
    for(const path of ['/api/overview','/api/media/pdf?pdf=a%3Ab','/api/media/upload?id=a','/api/media/page?page=2','/api/media/image?pdf=a&figure=b'])assert.equal(vm.runInContext(`appUrl(${JSON.stringify(path)})`,context),prefix+path);
    assert.equal(vm.runInContext('appUrl("https://publisher.example/paper")',context),'https://publisher.example/paper');
  }
});
