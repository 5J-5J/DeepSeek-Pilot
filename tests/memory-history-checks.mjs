import assert from "node:assert/strict";

// Called by settings-ui-test inside its isolated Chrome profile with real IndexedDB.
export async function runMemoryHistoryChecks(evaluate, reload) {
  const result = await evaluate(`(async()=>{
    const accountId='history-test-account';
    const call=async(type,body={})=>{
      const reply=await chrome.runtime.sendMessage({accountId,type:'dtw:'+type,...body});
      if(!reply.ok)throw new Error(reply.error);return reply;
    };
    const rawPut=memory=>DTWDB.transaction(['memories'],'readwrite',tx=>tx.objectStore('memories').put(memory));
    const get=id=>DTWDB.get('memories',[accountId,id]);
    const history=()=>DTWDB.get('memoryHistory',accountId);
    const remove=id=>DTWDB.remove('memories',[accountId,id]);
    const manual=(id,content,scope='PERSONAL',projectId=null)=>({accountId,memoryId:id,content,scope,projectId,
      kind:scope==='PERSONAL'?'偏好':'目标',state:'ACTIVE',version:1,pinnedByUser:true,updatedAtMs:Date.now()});
    const checks={};
    await DTWDB.put('settings',{accountId,key:'memoryStartAtMs',value:1});
    await DTWDB.put('settings',{accountId,key:'automationPaused',value:true});
    await DTWDB.put('settings',{accountId,key:'sessionMemoryV2',value:true});
    await DTWDB.put('projects',{accountId,projectId:'history-project',name:'恢复测试项目',pendingSessionRefs:[]});
    let first=manual('first','默认使用简洁中文');
    await DTWDB.put('memories',first);
    for(let version=2;version<=8;version++) {
      first={...first,version,content:'默认使用简洁中文 '+version};
      await DTWDB.put('memories',first);
    }
    checks.bounded=(await history()).snapshots.length;
    const second=manual('second','先明确目标');await DTWDB.put('memories',second);
    await remove('first');
    const ledgerBefore=await DTWDB.all('memoryTurns',accountId);
    const protectedSnapshot=await call('snapshot');
    checks.localRecovery=protectedSnapshot.memoryRecovery.restored===1 && (await get('first')).version===8;
    checks.ledgerUntouched=JSON.stringify(ledgerBefore)===JSON.stringify(await DTWDB.all('memoryTurns',accountId));
    checks.partial=(await get('second')).version===1;
    await remove('second');
    const previousAccount=fixtureStorage.accountId;
    try{fixtureStorage.accountId=accountId;await drainJobQueue();}finally{fixtureStorage.accountId=previousAccount;}
    checks.backgroundCheck=(await get('second')).content===second.content;
    await rawPut({...second,content:12});
    checks.corruptRepair=(await call('snapshot')).memoryRecovery.restored===1 && (await get('second')).content===second.content;
    // A bad write cannot replace the last usable backup, even if another write happens before checking.
    await DTWDB.put('memories',{...first,content:null});
    checks.validBackup=(await call('snapshot')).memoryRecovery.restored===1 && (await get('first')).content===first.content;
    await DTWDB.put('memories',{...first,version:2,content:'旧版本内容'});
    checks.versionRecovery=(await call('snapshot')).memoryRecovery.restored===1 && (await get('first')).version===8;
    await rawPut({...first,version:9,content:'用户刚修改的最新内容'});
    await call('snapshot');
    checks.newerPreserved=(await get('first')).content==='用户刚修改的最新内容';
    await DTWDB.put('memories',await get('first'));
    const beforeAbort=JSON.stringify(await history());
    let aborted=false;
    try{await DTWDB.removeMemories(accountId,[await get('first'),{...second,version:999}],'memoryEpoch:PERSONAL:',99);}catch{aborted=true;}
    checks.deleteRollback=aborted && Boolean(await get('first')) && beforeAbort===JSON.stringify(await history())
      && !await DTWDB.get('settings',[accountId,'memoryEpoch:PERSONAL:']);
    await call('memory-delete-batch',{scope:'PERSONAL',memories:[{memoryId:'first',version:9}]});
    await call('snapshot');
    let row=await history();
    checks.deleteIntent=!await get('first') && row.forgotten.some(item=>item.memoryId==='first')
      && row.snapshots.every(snapshot=>snapshot.memories.every(memory=>memory.memoryId!=='first'))
      && !JSON.stringify(row).includes('用户刚修改的最新内容');
    checks.normalizedIntent=DTWDB.isForgotten(row,{...first,memoryId:'another-id',content:' 用户 刚修改的最新内容 '});
    await rawPut({...first,content:'用户刚修改的最新内容'});
    await call('snapshot');
    checks.unexpectedResurrectionBlocked=!await get('first');
    checks.scopeIsolation=!DTWDB.isForgotten(row,{...first,memoryId:'another-id',scope:'PROJECT',projectId:'history-project',content:'用户刚修改的最新内容'});
    checks.idIntent=DTWDB.isForgotten(row,{...first,scope:'PROJECT',projectId:'history-project'});
    const project=manual('project-manual','手写项目目标','PROJECT','history-project');
    await DTWDB.put('memories',project);await remove(project.memoryId);
    checks.manualProject=(await call('snapshot')).memoryRecovery.restored===1;
    await call('memory-save-category',{scope:'PROJECT',projectId:'history-project',kind:'目标',
      expected:[{memoryId:project.memoryId,version:1}],entries:[]});
    row=await history();
    checks.categoryIntent=row.forgotten.some(item=>item.memoryId===project.memoryId)
      && row.snapshots.every(snapshot=>snapshot.memories.every(memory=>memory.memoryId!==project.memoryId));
    const saved=await call('memory-save',{memory:{scope:'PERSONAL',kind:'偏好',content:'用户刚修改的最新内容'}});
    checks.manualReadd=!DTWDB.isForgotten(await history(),saved.memory);
    await remove(saved.memory.memoryId);
    checks.manualReaddRecover=(await call('snapshot')).memoryRecovery.restored===1;

    async function source(id) {
      await DTWDB.put('sessions',{accountId,sessionId:id,purpose:'USER',createdAtMs:100,currentMessageId:2,loadedHistory:true});
      await DTWDB.put('memberships',{accountId,sessionId:id,projectId:'history-project',version:1});
      for(const record of [
        {messageId:1,parentId:null,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'以后请用中文；项目已经完成'}]},
        {messageId:2,parentId:1,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'确认'}]}
      ])await DTWDB.put('messages',{accountId,sessionId:id,...record});
      return memorySession(accountId,id,await settings(accountId));
    }
    async function automatic(id,scope='PROJECT') {
      const turn=await source(id);
      const memory={...manual(id,'来源记忆 '+id,scope,scope==='PROJECT'?'history-project':null),pinnedByUser:false,
        sourceSessionId:id,sourceMessageId:2,sourceSessionFingerprint:turn.fingerprint};
      await DTWDB.put('memories',memory);await remove(id);return memory;
    }
    await automatic('valid-source');
    checks.verifiedSource=(await call('snapshot')).memoryRecovery.restored===1 && (await get('valid-source')).state==='ACTIVE';
    const race=await automatic('race-source');
    const readTurn=memorySession;let changed=false;
    memorySession=async(...args)=>{
      const turn=await readTurn(...args);
      if(args[1]==='race-source' && !changed){
        changed=true;await DTWDB.put('memories',{...race,version:2,sourceSessionFingerprint:"changed"});await remove('race-source');
      }return turn;
    };
    try{await call('snapshot');checks.sourceRaceBlocked=!await get('race-source');}finally{memorySession=readTurn;}
    await automatic('edited-source');
    const edited=await DTWDB.get('messages',[accountId,'edited-source',1]);
    await DTWDB.put('messages',{...edited,fragments:[{type:'REQUEST',content:'新的要求'}]});
    await call('snapshot');checks.editedBlocked=!await get('edited-source');
    await rawPut({...manual('edited-source',12,'PROJECT','history-project'),pinnedByUser:false,sourceSessionId:'edited-source',sourceMessageId:2});
    checks.corruptUnavailableHidden=(await call('snapshot')).memories.every(memory=>memory.memoryId!=='edited-source');
    await remove('edited-source');
    await automatic('branch-source');
    const branched=await DTWDB.get('sessions',[accountId,'branch-source']);
    await DTWDB.put('sessions',{...branched,currentMessageId:1});
    await call('snapshot');checks.branchBlocked=!await get('branch-source');
    await automatic('moved-source');
    await DTWDB.put('memberships',{accountId,sessionId:'moved-source',projectId:'another-project'});
    await call('snapshot');checks.moveBlocked=!await get('moved-source');
    await automatic('deleted-source','PERSONAL');
    const deleted=await DTWDB.get('sessions',[accountId,'deleted-source']);
    await DTWDB.put('sessions',{...deleted,deleted:true});
    await call('snapshot');checks.deletedSourceBlocked=!await get('deleted-source');
    await automatic('old-source','PERSONAL');
    await DTWDB.put('settings',{accountId,key:'memoryStartAtMs',value:101});
    await call('snapshot');checks.cutoffBlocked=!await get('old-source');
    await DTWDB.put('settings',{accountId,key:'memoryStartAtMs',value:1});
    await automatic('stopped-source');
    const stopped=await history();
    const stoppedMemory=stopped.snapshots.at(-1).memories.find(memory=>memory.memoryId==='stopped-source');
    await DTWDB.put('memories',{...stoppedMemory,state:'DISABLED',version:2,disabledReason:'AUTO_REVIEW'});
    await remove('stopped-source');await call('snapshot');
    checks.disabledPreserved=(await get('stopped-source')).state==='DISABLED';
    const unrelated='other-history-account';
    await DTWDB.put('memories',{...manual('other','其他账号记忆'),accountId:unrelated});
    await DTWDB.remove('memories',[unrelated,'other']);await call('snapshot');
    checks.accountIsolation=!await DTWDB.get('memories',[unrelated,'other']);

    // A future batch repeating explicitly deleted content is filtered, yet its turns finish once.
    const forgotten=manual('forget-again','偏好中文回答');await DTWDB.put('memories',forgotten);
    await call('memory-delete-batch',{scope:'PERSONAL',memories:[{memoryId:forgotten.memoryId,version:1}]});
    const turn=await source('repeat-source');
    const queue=await ensurePersonalQueue(accountId);
    const ref=sessionRef(turn,['PERSONAL']);
    await DTWDB.put('sessions',{accountId,sessionId:'zz-current',purpose:'USER',createdAtMs:1000});
    await DTWDB.put('projects',{...queue,pendingSessionRefs:[ref]});
    const job={accountId,jobId:'history-repeat',type:'DISTILL',status:'RUNNING',tabId:55,sessionVersion:2,
      memoryScope:'PERSONAL',updateScopes:['PERSONAL'],projectId:null,memoryEpoch:await memoryEpoch(accountId,'PERSONAL',null),
      sourceSessionId:turn.sessionId,sessionRef:ref,createdAtMs:Date.now(),updatedAtMs:Date.now()};
    await prepareMemoryJob(job);await DTWDB.put('jobs',job);
    const kept=(await DTWDB.all('memories',accountId)).filter(row=>row.scope==='PERSONAL' && ['ACTIVE','STALE'].includes(row.state))
      .map(row=>({memoryId:row.memoryId,kind:row.kind,content:row.content}));
    await finishMemoryJob(accountId,job,{memories:[...kept,{memoryId:'',kind:'偏好',content:'偏好中文回答'}]});
    checks.modelForget=(await DTWDB.all('memories',accountId)).every(memory=>memory.content!=='偏好中文回答')
      && (await DTWDB.get('jobs',[accountId,job.jobId])).status==='DONE'
      && (await DTWDB.all('memoryTurns',accountId)).some(memory=>memory.sessionId==='repeat-source' && memory.state==='DONE');
    const autoDeleted={...manual('auto-deleted','模型删除的过时事实'),pinnedByUser:false,
      sourceSessionId:turn.sessionId,sourceMessageId:2,sourceSessionFingerprint:turn.fingerprint};
    await DTWDB.put('memories',autoDeleted);
    const deletionJob={...job,jobId:'auto-delete',status:'RUNNING',cachedResult:null,memorySnapshot:null};
    await prepareMemoryJob(deletionJob);await DTWDB.put('jobs',deletionJob);
    await finishMemoryJob(accountId,deletionJob,{memories:kept});
    const deletedHistory=await history();
    checks.modelDelete=!await get(autoDeleted.memoryId)
      && deletedHistory.snapshots.every(snapshot=>snapshot.memories.every(memory=>memory.memoryId!==autoDeleted.memoryId))
      && !DTWDB.isForgotten(deletedHistory,autoDeleted);
    const later=await source('repeat-source-later');
    const readdRef=sessionRef(later,['PERSONAL']);
    await DTWDB.put('projects',{...await ensurePersonalQueue(accountId),pendingSessionRefs:[readdRef]});
    const readdJob={...job,jobId:'auto-readd',status:'RUNNING',sourceSessionId:later.sessionId,sessionRef:readdRef,cachedResult:null,memorySnapshot:null};
    await prepareMemoryJob(readdJob);await DTWDB.put('jobs',readdJob);
    await finishMemoryJob(accountId,readdJob,{memories:[...kept,{memoryId:'',kind:'偏好',content:autoDeleted.content}]});
    checks.modelReadd=(await DTWDB.all('memories',accountId)).some(memory=>memory.content===autoDeleted.content);
    // An aborted automated write rolls back its snapshot alongside the actual data.
    const beforeBatch=JSON.stringify(await history());let batchAborted=false;
    try{await DTWDB.commitMemoryBatch(accountId,[],()=>({memories:[manual('rollback','不该保存')],jobs:[{accountId}]}));}catch{batchAborted=true;}
    checks.batchRollback=batchAborted && !await get('rollback') && beforeBatch===JSON.stringify(await history());
    checks.unavailableReported=(await call('snapshot')).memoryRecovery.unavailable>=4;
    await remove('second');
    return checks;
  })()`);
  assert.equal(result.bounded, 5, "每个账号只保留五份最近快照");
  for (const [name, passed] of Object.entries(result)) if (name !== "bounded") assert.equal(passed, true, `记忆保护检查失败：${name}`);
  await reload();
  const restarted = await evaluate(`(async()=>{
    await globalThis.__fixtureReady;
    const snapshot=await chrome.runtime.sendMessage({accountId:'history-test-account',type:'dtw:snapshot'});
    return {ok:snapshot.ok,restored:snapshot.memoryRecovery?.restored,
      remembered:snapshot.memories?.some(memory=>memory.memoryId==='second'),
      forgotten:snapshot.memories?.some(memory=>memory.memoryId==='forget-again')};
  })()`);
  assert.deepEqual(restarted, { ok: true, restored: 1, remembered: true, forgotten: false }, "后台重启后仍能恢复局部丢失并保持删除意图");
}
