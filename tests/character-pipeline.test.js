const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const load=name=>import(pathToFileURL(path.join(__dirname,'../src/renderer/js',name)).href);
const variant=(width=320,layers=1)=>({frameWidth:width,frameHeight:width*420/320,pages:[{file:'a.webp',width:width+4,height:width*420/320+4}],layers:Array.from({length:layers},(_,i)=>({id:`part${i}`,frames:[{page:0,x:2,y:2}]}))});

test('native frame extraction and bust crop are independent of logical coordinates',async()=>{
  const {atlasRect,dimensions}=await load('character-assets.js');
  for(const width of [320,640,960]){
    const s=width/320,c={columns:4,frameWidth:width,frameHeight:420*s};
    assert.deepEqual(atlasRect(5,c),{x:width,y:420*s,width,height:420*s});
    assert.deepEqual(atlasRect(5,c,{x:55,y:14,width:210,height:275.625}),{x:width+55*s,y:420*s+14*s,width:210*s,height:275.625*s});
  }
  assert.deepEqual(dimensions({}),{width:320,height:420});
  assert.throws(()=>dimensions({frameWidth:640,frameHeight:420}));
});

test('resolution selection accounts for DPI, GPU limits and working-set memory',async()=>{
  const {chooseVariant}=await load('character-assets.js'),vs=[variant(),variant(640),variant(960)];
  assert.equal(chooseVariant(vs,.6).frameWidth,320);
  assert.equal(chooseVariant(vs,1.6).frameWidth,640);
  assert.equal(chooseVariant(vs,3).frameWidth,960);
  assert.equal(chooseVariant(vs,3,1024).frameWidth,640);
  assert.equal(chooseVariant(vs,3,512).frameWidth,320);
  assert.equal(chooseVariant(vs,3,256),null);
  assert.equal(chooseVariant(vs,3,4096,600000).frameWidth,320);
});

test('manifest rejects invalid UVs, cycles, duplicate IDs and tracks',async()=>{
  const {validateManifest}=await load('character-assets.js');
  const make=()=>({version:2,variants:[variant()]});
  assert.ok(validateManifest(make()));
  let m=make();m.variants[0].layers[0].frames[0].x=900;assert.throws(()=>validateManifest(m));
  m=make();m.variants[0].layers[0].parent='part0';assert.throws(()=>validateManifest(m));
  m=make();m.variants[0].layers[0].tracks={idle:[44]};assert.throws(()=>validateManifest(m));
  m=make();m.variants[0].pages[0].file='../outside.png';assert.throws(()=>validateManifest(m));
});

test('shared cache bounds memory, serializes decodes and closes evicted images',async()=>{
  const {AtlasCache}=await load('character-assets.js');let inFlight=0,max=0,closed=0,decodes=0;
  const cache=new AtlasCache({budget:800,decode:async()=>{
    decodes++;max=Math.max(max,++inFlight);await new Promise(r=>setTimeout(r,1));inFlight--;
    return {width:10,height:10,close(){closed++;}};
  }});
  const page=url=>({url,width:10,height:10});
  await Promise.all(['a','b','c'].map(id=>cache.group([page(id)],images=>assert.equal(images.length,1))));
  assert.equal(max,1);assert.equal(cache.bytes,800);assert.equal(closed,1);
  await cache.group([page('c')],()=>{});assert.equal(decodes,3);
  await assert.rejects(cache.group([page('d'),page('e'),page('f')],()=>{}));
  cache.clear();assert.equal(cache.bytes,0);assert.equal(closed,3);
});

test('springs remain bounded after impulses, variable dt, gravity and suspension',async()=>{
  const {Spring,springSettings}=await load('character-rig.js');
  const s=new Spring({mass:.01,stiffness:999,damping:0,max:3});
  assert.equal(springSettings({mass:0}).mass,.1);
  for(let i=0;i<2000;i++){s.step(i%2?.016:9,i<500?100000:0);assert.ok(Number.isFinite(s.x)&&Math.abs(s.x)<=3);}
  assert.ok(Math.abs(s.x)<.01);s.reset();assert.equal(s.v,0);
});

test('ground-registered legs, parented features and reduced motion',async()=>{
  const {CharacterRig,applyPose}=await load('character-rig.js');
  const rig=new CharacterRig(),leg={id:'leg',role:'leg',pivot:[140,270],foot:[140,418]};
  for(let i=0;i<200;i++){
    const context={position:{x:i,y:0},moving:true,state:'idle'};
    const motion=rig.update(i*16,context),p=rig.pose(leg,motion,context);
    const footY=270+Math.cos(p.angle)*148+p.y;
    assert.ok(footY<=418.00001&&footY>=410);
  }
  const context={position:{x:9999,y:0},still:true,state:'idle'};
  const motion=rig.update(4000,context);assert.ok(motion.teleport);
  assert.deepEqual(rig.pose({...leg,physics:{}},motion,context),{x:0,y:0,angle:0});
  const calls=[],ctx={translate:(...v)=>calls.push(v),rotate:()=>{}};
  const layers=[{id:'head',pivot:[0,0]},{id:'eyes',parent:'head',pivot:[0,0]}];
  applyPose(ctx,layers[1],new Map([['head',{x:3,y:4,angle:.1}],['eyes',{x:1,y:2,angle:0}]]),layers);
  assert.deepEqual(calls[0],[3,4]);assert.deepEqual(calls[2],[1,2]);
});

test('independent blink, mouth, gaze and leg tracks preserve other states',async()=>{
  const {trackFrame}=await load('character-rig.js');
  const layer={frames:[{},{},{},{}],tracks:{idle:[0],open:[0],closed:[1],blink:[2],round:[3],walk:[1,2],sit:[3],success:[2],error:[3],thinking:[1]}};
  assert.equal(trackFrame({...layer,role:'eyes'},'idle',4600),2);
  assert.equal(trackFrame({...layer,role:'eyes'},'idle',4600,4,{still:true}),0);
  assert.equal(trackFrame({...layer,role:'eyes'},'sleep',0),1);
  assert.equal(trackFrame({...layer,role:'mouth'},'thinking',0,4,{talk:.1}),3);
  assert.equal(trackFrame({...layer,role:'mouth'},'idle',0,4,{viseme:'closed',talk:1}),1);
  assert.equal(trackFrame({...layer,role:'leg'},'idle',250,4,{moving:true}),2);
  assert.equal(trackFrame({...layer,role:'leg'},'idle',0,4,{stance:'sit'}),3);
  for(const [state,index] of [['thinking',1],['success',2],['error',3]])assert.equal(trackFrame(layer,state,0),index);
});

test('optional composite action tracks yield to speech, alerts and reduced motion',async()=>{
  const {trackFrame}=await load('character-rig.js');
  const layer={role:'composite',frames:Array.from({length:8},()=>({})),
    tracks:{idle:[0],attention:[1],held:[2,3],walk:[4,5],sit:[6],dance:[7],wake:[1,2,3]}};
  assert.equal(trackFrame(layer,'idle',250,4,{stance:'held',act:'grabbed'}),3);
  assert.equal(trackFrame(layer,'idle',250,4,{stance:'stand',clip:'walk'}),5);
  assert.equal(trackFrame(layer,'idle',0,4,{stance:'sit'}),6);
  assert.equal(trackFrame(layer,'idle',0,4,{stance:'stand',dance:true}),7);
  assert.equal(trackFrame(layer,'idle',0,4,{stance:'sit',dance:true}),6);
  assert.equal(trackFrame(layer,'idle',9999,4,{stance:'stand',special:{name:'wake',elapsed:250}}),2);
  for(const context of [{still:true},{talk:.5},{lineTalking:true},{act:'hop'},{reaction:'attention'}])
    assert.equal(trackFrame(layer,'idle',0,4,{stance:'stand',clip:'walk',...context}),0);
  assert.equal(trackFrame(layer,'attention',0,4,{stance:'stand',clip:'walk'}),1);
  assert.equal(trackFrame({...layer,tracks:{idle:[0]}},'idle',0,4,{stance:'sit'}),0);
});

test('Mochi motion packs keep both views and include bounded action tracks',async()=>{
  const fs=require('node:fs');
  const {validateManifest}=await load('character-assets.js');
  const catalog=require('../assets/characters/catalog.json');
  const mochi=catalog.find(c=>c.id==='mochi');
  for(const file of [mochi.spriteManifest,mochi.bustManifest]) {
    const manifest=validateManifest(JSON.parse(fs.readFileSync(path.join(__dirname,'../assets/characters',file))));
    for(const variant of manifest.variants) {
      const tracks=variant.layers[0].tracks;
      assert.equal(tracks.walk.length,4);
      assert.equal(tracks.dance.length,4);
      assert.ok(new Set(tracks.sit).size>=3);
      assert.ok(new Set(tracks.held).size>=4);
      assert.equal(tracks.wake.length,4);
      assert.equal(tracks.arrive.length,4);
      assert.deepEqual(tracks.leave,[...tracks.arrive].reverse());
      for(const page of variant.pages) assert.ok(fs.existsSync(path.join(__dirname,'../assets/characters',path.dirname(file),page.file)));
    }
  }
});

test('Lili action packs keep both views and play walking independently of speech rate',async()=>{
  const fs=require('node:fs');
  const {validateManifest}=await load('character-assets.js');
  const {trackFrame}=await load('character-rig.js');
  const lili=require('../assets/characters/catalog.json').find(c=>c.id==='lili');
  for(const file of [lili.spriteManifest,lili.bustManifest]) {
    const manifest=validateManifest(JSON.parse(fs.readFileSync(path.join(__dirname,'../assets/characters',file))));
    for(const variant of manifest.variants) {
      const layer=variant.layers[0];
      assert.equal(layer.tracks.walk.length,4);assert.equal(layer.tracks.sit.length,4);assert.equal(layer.tracks.wake.length,3);
      assert.equal(layer.tracks.perch_arrive.length,4);assert.deepEqual(layer.tracks.perch_leave,[...layer.tracks.perch_arrive].reverse());
      assert.equal(layer.tracks.arrive.length,4);assert.deepEqual(layer.tracks.leave,[...layer.tracks.arrive].reverse());
      assert.equal(trackFrame(layer,'idle',250,lili.fps,{stance:'stand',clip:'walk',actionFps:lili.actionFps}),layer.tracks.walk[1]);
      assert.equal(trackFrame(layer,'idle',250,lili.fps,{stance:'stand',clip:'walk',actionFps:lili.actionFps,still:true}),layer.tracks.idle[0]);
    }
  }
});

test('Mochi walks in both directions and stops for interaction or reduced motion',async()=>{
  global.matchMedia ??= () => ({matches:false,addEventListener(){}});
  const {Capri}=await load('capri.js');
  const {reducedMotion}=await load('util.js');
  const previous=global.requestAnimationFrame,setting=reducedMotion.setting;
  let next;
  global.requestAnimationFrame=fn=>{next=fn;};
  try {
    reducedMotion.setting='full';
    const make=x=>({pos:{x},view:{w:1000},wander:true,mode:'idle',stance:'stand'});
    for(const [x,dir] of [[100,1],[900,-1]]) {
      const actor=make(x);Capri.prototype.characterStroll.call(actor);
      assert.equal(actor.facing,-dir);assert.ok(actor.characterWalking);
      next(performance.now()+1200);assert.ok((actor.pos.x-x)*dir>0);
      actor.dragging=true;next(performance.now()+1300);assert.equal(actor.characterWalking,null);
    }
    reducedMotion.setting='reduced';
    const actor=make(100);Capri.prototype.characterStroll.call(actor);assert.equal(actor.characterWalking,undefined);
  } finally {global.requestAnimationFrame=previous;reducedMotion.setting=setting;}
});

test('available idle actions are equally likely and never randomly select dancing',async()=>{
  global.matchMedia ??= () => ({matches:false,addEventListener(){}});
  const {Capri}=await load('capri.js');
  const previous=Math.random;
  try {
    for(const [id,seat,expected] of [['mochi',null,['peek','teleport','flourish','walk']],['mochi',{},['sit','peek','teleport','flourish','walk']],['lili',{},['sit','peek','teleport','flourish','walk']],['capri',{},['sit','peek','teleport','flourish','walk']]]) {
      for(let i=0;i<expected.length;i++) {
        let action='';Math.random=()=>(i+.5)/expected.length;
        const actor={wander:true,locked:false,stance:'stand',fondness:0,character:{id,renderer:id==='capri'?'capri':undefined},
          pickSeat:()=>seat,peek:()=>{action='peek';},characterStroll:()=>{action='walk';},capriStroll:()=>{action='walk';},
          sitOn:()=>{action='sit';},spot:()=>({}),teleport:()=>{action='teleport';},flourish:()=>{action='flourish';},capriDance:()=>{action='dance';}};
        Capri.prototype.wanderStep.call(actor);
        assert.equal(action,expected[i],`character=${id}, seat=${!!seat}, index=${i}`);
      }
    }
    for(const [perch,canPossess,expected] of [[{id:'taskbar'},false,['flourish','teleport']],[{id:'window'},false,['flourish','fall','teleport']],[{id:'window'},true,['flourish','fall','teleport','possess']]]) {
      for(let i=0;i<expected.length;i++) {
        let action='';Math.random=()=>(i+.5)/expected.length;
        const actor={wander:true,locked:false,stance:'sit',perch,fondness:0,canPossess:()=>canPossess,
          flourish:()=>{action='flourish';},fall:()=>{action='fall';},spot:()=>({}),
          teleport:()=>{action='teleport';},possess:()=>{action='possess';}};
        Capri.prototype.wanderStep.call(actor);assert.equal(action,expected[i]);
      }
    }
  } finally {Math.random=previous;}
});

test('dancing requires an actively playing media session',async()=>{
  global.matchMedia ??= () => ({matches:false,addEventListener(){}});
  const {Capri}=await load('capri.js');
  let context;
  const actor={animate(){},place(){},sprite:{draw(_p,c){context=c;}},p:{},mode:'idle',stance:'stand',
    character:{id:'mochi'},pos:{x:0,y:0},manualDance:true,capriAmbient:{name:'dance'}};
  Capri.prototype.drawFrame.call(actor,100);
  assert.equal(context.dance,false);assert.equal(context.clip,undefined);
  actor.musicDance=true;Capri.prototype.drawFrame.call(actor,101);assert.equal(context.dance,true);
  actor.character.id='lili';actor.stance='sit';Capri.prototype.drawFrame.call(actor,102);assert.equal(context.dance,true);
  actor.musicDance=false;Capri.prototype.drawFrame.call(actor,103);assert.equal(context.dance,false);
  actor.musicDance=false;await Capri.prototype.capriDance.call(actor);assert.equal(actor.capriAmbient.name,'dance');
});

test('shipped bust art contains six distinct native-size source poses and validated atlas pages', async()=>{
  const fs=require('node:fs');
  const {validateManifest,chooseVariant}=await load('character-assets.js');
  for(const id of ['mochi','lili','luna','pudding']){
    const root=path.join(__dirname,'../assets/characters',id);
    const manifest=validateManifest(JSON.parse(fs.readFileSync(path.join(root,'bust-hd/manifest.json'))));
    const variant=chooseVariant(manifest.variants,2,2048);
    assert.equal(variant.frameWidth,640);
    assert.match(manifest.sourceDetail,/512x512/);
    assert.equal(new Set(variant.layers[0].frames.map(f=>`${f.page}/${f.x}/${f.y}`)).size,6);
    for(const page of variant.pages)assert.ok(fs.statSync(path.join(root,'bust-hd',page.file)).size>1000);
    const {trackFrame}=await load('character-rig.js');
    const composite=variant.layers[0];
    assert.equal(trackFrame(composite,'sleep',0),5);
    assert.equal(trackFrame(composite,'thinking',0),4);
    assert.equal(trackFrame(composite,'success',0),3);
    assert.equal(trackFrame(composite,'idle',180,4,{talk:1}),2);
  }
});

test('new full-body atlases include six registered frames with a genuine higher tier', async()=>{
  const fs=require('node:fs');
  const {validateManifest,chooseVariant}=await load('character-assets.js');
  for(const id of ['mochi','lili','luna','pudding']){
    const root=path.join(__dirname,'../assets/characters',id,'full-hd');
    const manifest=validateManifest(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))));
    const tier=chooseVariant(manifest.variants,1.5,2048);
    assert.equal(tier.frameWidth,640);
    assert.match(manifest.sourceDetail,/no upscaling/);
    assert.equal(new Set(tier.layers[0].frames.map(f=>`${f.page}/${f.x}/${f.y}`)).size,6);
    for(const page of tier.pages)assert.ok(fs.statSync(path.join(root,page.file)).size>1000);
  }
});

test('Luna uses the new face for both views and every expression and speech track', async()=>{
  const fs=require('node:fs');
  const luna=require('../assets/characters/catalog.json').find(c=>c.id==='luna');
  const {validateManifest}=await load('character-assets.js');
  for(const key of ['spriteManifest','bustManifest']) {
    assert.match(luna[key],/luna\/face-0\.22-(full|bust)\/manifest.json$/);
    const file=path.join(__dirname,'../assets/characters',luna[key]);
    const manifest=validateManifest(JSON.parse(fs.readFileSync(file)));
    for(const variant of manifest.variants) {
      const layer=variant.layers[0];
      assert.equal(layer.frames.length,12);
      for(const state of ['idle','blink','thinking','attention','success','error','sleep','wave',
        'talkNeutral','talkPrepare','talkSoft','talkRound','talkEmphasis','talkRest'])assert.ok(layer.tracks[state]?.length,state);
      for(const page of variant.pages)assert.ok(fs.statSync(path.join(path.dirname(file),page.file)).size>1000);
    }
  }
});
