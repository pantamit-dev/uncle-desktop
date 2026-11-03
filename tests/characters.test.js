'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CHARACTERS, characterFor } = require('../src/main/characters');

global.matchMedia ??= () => ({ matches: false, addEventListener() {} });
const load = (file) => import(pathToFileURL(path.join(__dirname, '../src/renderer/js', file)).href);

test('only shipped character IDs resolve, and each has the complete asset set', () => {
  assert.equal(characterFor('blacky').name, 'Blacky');
  assert.equal(characterFor('capri').renderer, 'capri');
  for (const id of ['bald-man', 'lazy-boy', 'angry-guy', 'drunk-uncle', 'vulture', 'chubby-girl', 'cute-girl', 'fatty-girl', 'pinky', 'mira', 'mochi', 'lili', 'luna', 'pudding', 'tama', 'peegee']) {
    assert.equal(characterFor(id).id, id, `Missing requested character: ${id}`);
  }
  assert.equal(characterFor('../../missing').id, 'angry-boy');
  assert.equal(characterFor(null).id, 'angry-boy');
  assert.equal(new Set(CHARACTERS.map((c) => c.id)).size, CHARACTERS.length);
  for (const character of CHARACTERS) {
    if (character.renderer !== 'capri') assert.equal(character.columns * character.rows, 24);
    const expressions = character.renderer === 'capri' ? [] : ['thinking', 'attention', 'success', 'error', 'sleep'].map((s) => `${character.id}/${s}.png`);
    for (const asset of [character.atlas, character.portrait, ...expressions]) {
      assert.ok(fs.statSync(path.join(__dirname, '../assets/characters', asset)).size > 1000, asset);
    }
  }
});

test('animation priority keeps permission visible, and reactions return to the current work state', async () => {
  const { animationFor, frameFor } = await load('character-renderer.js');
  assert.equal(animationFor({ mode: 'alert', reaction: 'success' }), 'attention');
  assert.equal(animationFor({ mode: 'work', reaction: 'error' }), 'error');
  assert.equal(animationFor({ mode: 'work' }), 'thinking');
  assert.equal(animationFor({ mode: 'idle', act: 'victory' }), 'success');
  assert.equal(animationFor({ mode: 'sleep' }), 'sleep');
  assert.equal(animationFor({ mode: 'idle' }), 'idle');
  assert.equal(frameFor('error', 0), 16);
  assert.equal(frameFor('error', 250), 17);
  assert.equal(frameFor('error', 1000), 16);
  assert.equal(frameFor('sleep', 9500, 4, true), 20);
  assert.ok(frameFor('unknown', 500) < 4);
});

test('pose transitions fade out promptly and respect reduced motion', async () => {
  const { poseBlend } = await load('character-renderer.js');
  assert.equal(poseBlend(0), 1);
  assert.equal(poseBlend(90), 0.5);
  assert.equal(poseBlend(180), 0);
  assert.equal(poseBlend(1000), 0);
  assert.equal(poseBlend(0, true), 0);
  assert.equal(poseBlend(55, false, 110), .5);
  assert.equal(poseBlend(130, false, 110), 0, 'Ordered poses must settle before the next speech frame');
});

test('Mochi has thirty registered ordered poses in both views with a legacy fallback', async()=>{
  const {validateManifest}=await load('character-assets.js');
  const mochi=characterFor('mochi');
  assert.equal(mochi.orderedSpeech,true);
  assert.equal(mochi.fps,4);
  for(const relative of [mochi.spriteManifest,mochi.bustManifest]) {
    const manifest=validateManifest(JSON.parse(fs.readFileSync(path.join(__dirname,'../assets/characters',relative))));
    assert.match(manifest.sourceDetail,/authored motion/);
    assert.deepEqual(manifest.variants.map(v=>v.frameWidth),[320,640]);
    for(const variant of manifest.variants) {
      const layer=variant.layers[0];
      assert.ok(layer.frames.length>=30);
      assert.equal(layer.continuousTracks,true);
      assert.deepEqual(layer.tracks.speechMotion,[24,25,26,27,28,29]);
      for(const state of ['thinking','attention','success','error','sleep'])assert.equal(layer.tracks[state].length,4);
      assert.ok(variant.pages.every(p=>p.width<=2048 && p.height<=2048));
    }
  }
  assert.equal(mochi.columns*mochi.rows,24);
});

test('bust framing stays registered when a full-body manifest uses a fitted crop', async () => {
  const { viewCrop } = await load('character-renderer.js');
  const source={manifest:{crop:{x:80,y:210,width:160,height:210}}};
  const crop=viewCrop({},'bust',source);
  assert.equal(crop.x,107.5);
  assert.equal(crop.y,217);
  assert.equal(crop.width/crop.height,320/420);
  assert.ok(crop.x>=80 && crop.y>=210 && crop.x+crop.width<=240 && crop.y+crop.height<=420);
});

test('new conversation packs preserve important states and contain six separate gestures', async () => {
  const { validateManifest } = await load('character-assets.js');
  for(const character of CHARACTERS.filter(c=>c.conversationPoses)) {
    for(const relative of [character.spriteManifest,character.bustManifest].filter(Boolean)) {
      const file=path.join(__dirname,'../assets/characters',relative);
      const manifest=validateManifest(JSON.parse(fs.readFileSync(file)));
      for(const variant of manifest.variants) {
        const layer=variant.layers[0];
        for(const state of ['idle','thinking','attention','success','error','sleep'])assert.ok(layer.tracks[state]?.length,`${character.id}/${state}`);
        const poses=['talkNeutral','talkPrepare','talkSoft','talkRound','talkEmphasis','talkRest'].map(k=>layer.tracks[k]?.[0]);
        assert.equal(new Set(poses).size,6,`${character.id}: needs six authored conversation poses`);
        for(const page of variant.pages)assert.ok(fs.statSync(path.join(path.dirname(file),page.file)).size>1000);
      }
    }
  }
});

test('speaking uses authored mouth frames and respects sleep and reduced motion', async () => {
  const { speakingFrame, frameFor, sourceRect } = await load('character-renderer.js');
  assert.equal(speakingFrame('idle', 0, 4, false, 0.7, true), 9);
  assert.equal(speakingFrame('idle', 140, 4, false, 0.7, true), 10);
  assert.equal(speakingFrame('idle', 140, 4, false, 0, true), frameFor('idle', 140, 4));
  assert.equal(speakingFrame('sleep', 0, 4, false, 0.7, true), 20);
  assert.equal(speakingFrame('idle', 0, 4, true, 0.7, true), 0);
  assert.equal(speakingFrame('idle', 0, 4, false, 0.7, false), 0);
  const crop = sourceRect({}, 'bust');
  assert.equal(crop.width / crop.height, 320 / 420, 'upper-body framing must not stretch the face');
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 320 && crop.y + crop.height <= 420);
  assert.deepEqual(sourceRect({}, 'full'), { x: 0, y: 0, width: 320, height: 420 });
});

test('character copy changes identity without mutating the original locale or another character', async () => {
  const { linesFor, LINES } = await load('lines.js');
  const original = LINES.th.welcome.hi;
  for (const character of CHARACTERS) {
    const text = linesFor('th', 'codex', character);
    assert.match(text.welcome.hi, new RegExp(character.name));
    assert.match(text.welcome.about, /Codex/);
    if (character.renderer !== 'capri') assert.doesNotMatch(text.chat.note, /Capri/);
    assert.equal(linesFor('th', 'codex', character), text);
  }
  assert.equal(LINES.th.welcome.hi, original);
});

test('chat uses the selected game character personality for text and vision', async () => {
  const { Chat } = await load('chat.js');
  const chat = Object.create(Chat.prototype);
  chat.powers = () => [];
  let remembered;
  chat.host = { chatRemember(history, characterId) { remembered = { history, characterId }; } };
  for (const character of CHARACTERS) {
    chat.brain = { lang: 'th', assistant: 'codex', watching: true, context: () => '', character };
    assert.ok(chat.persona().startsWith(character.personality));
    assert.ok(chat.lookPersona().startsWith(character.personality));
    assert.match(chat.persona(), /ตอบเป็นภาษาไทย/);
    chat.history = [];
    chat.remember({ role: 'assistant', content: character.name });
    assert.equal(remembered.characterId, character.id);
    assert.equal(remembered.history[0].content, character.name);
  }
});

test('removed Honey is absent and an old Honey selection falls back to UncleDev', () => {
  assert.ok(!CHARACTERS.some(c => c.id === 'honey'));
  assert.equal(characterFor('honey').id, 'angry-boy');
  assert.ok(!fs.existsSync(path.join(__dirname, '../assets/characters/honey')));
});
