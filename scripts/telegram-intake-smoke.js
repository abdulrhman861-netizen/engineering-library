'use strict';
const {readFileSync}=require('node:fs');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const path=require('node:path');
const source=readFileSync('server.js','utf8');
const start=source.indexOf('async function intakeTelegramFile(');
const end=source.indexOf('async function handleTelegramCallback(',start);
assert.ok(start>=0&&end>start);
const records=new Map(), receipts=[], downloads=[];
const ctx={
  path,console,MIME_BY_EXTENSION:{'.jpg':'image/jpeg','.pdf':'application/pdf'},
  pool:{async query(sql,args){
    if(sql.startsWith('select'))return {rowCount:Number(records.has(args[0]))};
    assert.match(sql,/'UNPAID'.*'TELEGRAM'/);
    assert.doesNotMatch(sql,/direct_print_status/);
    records.set(args[9],args);
    return {rowCount:1,rows:[{file_id:records.size}]};
  }},
  async tgDownloadFile(id,name,mime){downloads.push({id,name,mime});return {
    file:{originalname:name},stored:{url:'/uploads/'+name,storagePath:name},pageCount:2
  };},
  async tgSend(chat,text){receipts.push({chat,text});},
  tgPrice:()=>100
};
vm.runInNewContext(source.slice(start,end),ctx);
(async()=>{
  const message={chat:{id:15,type:'private'},from:{id:15,first_name:'طالب'},message_id:9,
    photo:[{file_id:'small'},{file_id:'large'}],caption:'وجه وظهر'};
  await ctx.handleTelegramMessage(message);
  await ctx.handleTelegramMessage(message);
  await ctx.handleTelegramMessage({...message,chat:{id:20,type:'supergroup'}});
  assert.equal(downloads.length,1);
  assert.equal(downloads[0].id,'large');
  assert.equal(records.get('telegram:15:9')[4],'وارد من تيليجرام — وجه وظهر');
  assert.match(receipts[0].text,/#1/);
  await ctx.handleTelegramMessage({...message,photo:undefined,message_id:10,document:{file_id:'pdf',file_name:'sheet.pdf',mime_type:'text/html'}});
  assert.equal(downloads[1].mime,'application/pdf');
  assert.equal(records.size,2);
  await ctx.handleTelegramMessage({...message,photo:undefined,message_id:11,document:{file_id:'html',file_name:'page.html'}});
  assert.equal(downloads.length,2);
  assert.match(receipts.at(-1).text,/غير مدعوم/);
  console.log('Telegram intake smoke checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
