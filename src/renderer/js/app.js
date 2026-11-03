import { Capri } from './capri.js';
import { FxLayer } from './fx.js';
import { Chip, Mask } from './chip.js';
import { Panel } from './panel.js';
import { Voice } from './voice.js';
import { Brain } from './brain.js';
import { Guide } from './guide.js';
import { Mission } from './mission.js';
import { Chat } from './chat.js';
import { Setup } from './setup.js';
import { Custom } from './custom.js';
import { CharacterPicker } from './character-picker.js';
import { loadCharacterSource } from './character-assets.js';
import { Speech } from './speech.js';
import { Listening } from './listening.js';
import { VoiceAgent } from './voice-agent.js';
import { Computer } from './computer.js';
import * as media from './media.js';
import { Settings } from './settings.js';
import { Bond, Jealousy } from './bond.js';
import { Reminders, clock } from './reminders.js';
import { Look } from './look.js';
import { Pc } from './pc.js';
import { linesFor } from './lines.js';
import { pick, fmt, reducedMotion } from './util.js';

const host = window.host;
const characterAsset = (character, key) => character.custom ? character[key] : `../../assets/characters/${character[key]}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const WATCH_MS = 2000; // how often she checks the pointer still reaches her
const FOLLOW_AFTER = 2; // checks in a row with the pointer on another screen before she follows it there
const AWAY_MS = 15 * 60 * 1000; // the pointer still this long: you were away from your PC
const SNOOZE_MS = 10 * 60 * 1000;

// what you made her, from the config (custom.js)
const mine = (cfg) => ({ userName: cfg.userName || '', persona: cfg.persona || '', myLines: cfg.myLines || [], memories: cfg.memories || [] });

async function boot() {
  const config = await host.getConfig();
  let characters = config.characters || [];
  let picker = null;
  let speechUI = null;
  let listeningUI = null;
  let settingsUI = null;
  let computerUI = null;
  const loadCharacter = (character) => Promise.all([
    character.renderer === 'capri' ? loadImage(characterAsset(character, 'atlas')) : loadCharacterSource(character),
    loadImage(characterAsset(character, 'portrait')),
  ]);
  const [image, portrait] = await loadCharacter(config.character);
  await Promise.all([
    document.fonts.load('600 16px "Chakra Petch"'),
    document.fonts.load('400 11px "JetBrains Mono"'),
  ]);
  document.documentElement.lang = config.lang;
  // her animations: like Windows, full or reduced (her menu)
  const applyMotion = (setting) => {
    reducedMotion.setting = setting || 'auto';
    document.documentElement.dataset.motion = reducedMotion.matches ? 'reduced' : 'full';
  };
  applyMotion(config.motion);
  reducedMotion.onSystemChange(() => applyMotion(reducedMotion.setting));

  const fx = new FxLayer(document.getElementById('fx'));
  fx.resize(innerWidth, innerHeight);
  // how far the top of the taskbar is from the bottom of her window: she covers it too while she
  // rests on it (the floor she stands on stays its top)
  let floorGap = config.floorGap ?? 0;
  const chip = new Chip(document.getElementById('chip'));
  chip.place(innerWidth, innerHeight - floorGap);
  const mask = new Mask(document.getElementById('mask'));
  chip.portrait = mask.portrait = config.character.renderer === 'capri' ? null : portrait;

  const voice = new Voice();
  voice.configure(config);
  host.listSounds().then((list) => list.length && voice.loadCustom(list));

  const panel = new Panel({
    panel: document.getElementById('panel'),
    ticker: document.getElementById('ticker'),
    labels: linesFor(config.lang, config.assistant, config.character),
  });

  const capri = new Capri({
    root: document.getElementById('capri'),
    canvas: document.getElementById('sprite'),
    image,
    character: config.character,
    fx,
    voice,
  });
  capri.wander = config.wander;
  capri.possessWindows = config.possess;
  capri.restOn = config.rest || 'corner';
  capri.setView(innerWidth, innerHeight, innerHeight - floorGap);
  capri.setScale(config.scale);
  capri.setFraming(config.characterFraming);

  const mission = new Mission();
  const brain = new Brain({ capri, panel, voice, host, mission, lang: config.lang, assistant: config.assistant });
  brain.character = config.character;
  const identify = (character) => {
    const base = `../../assets/characters/${character.id}/`;
    panel.characterPortraits = character.renderer === 'capri' ? null : {
      default: base + 'portrait.png',
      grin: base + 'success.png', laugh: base + 'success.png',
      aside: base + 'thinking.png', look: base + 'thinking.png',
      angry: base + 'error.png', worry: base + 'error.png',
      many: base + 'attention.png',
    };
    if (character.custom) panel.characterPortraits = Object.fromEntries(Object.keys(panel.characterPortraits).map((key) => [key, character.portrait]));
    panel.el.querySelector('.panel__who').textContent = character.name;
    panel.portrait.alt = character.name;
    panel.setFace('calm');
    document.title = character.name + ' · Desktop Companion';
    document.getElementById('sprite').setAttribute('aria-label', character.name);
    document.getElementById('chip').setAttribute('aria-label', character.name);
    document.getElementById('mask').setAttribute('aria-label', character.name);
  };
  identify(config.character);

  // Click-through everywhere except on her body, the panel and her biochip.
  let interactive = false;
  // The mic status and the mini player: full or a small icon (Settings), dragged anywhere, where
  // you left them remembered per look. A drag doesn't count as a click.
  let badgeDrag = null, badgeCfg = config;
  const BADGES = [['mic', 'listening-stop'], ['player', 'mini-player']];
  const badgeLook = () => {
    for (const [key, id] of BADGES) {
      const node = document.getElementById(id); if (!node) continue;
      const look = badgeCfg.badges?.[key] === 'icon' ? 'icon' : 'full';
      node.classList.toggle('is-icon', look === 'icon');
      const p = badgeCfg.badgePos?.[`${key}-${look}`];
      // kept on screen: a place saved on a bigger display
      Object.assign(node.style, p ? { left: 'auto', top: 'auto', right: `${Math.min(p.right, innerWidth - 48)}px`, bottom: `${Math.min(p.bottom, innerHeight - 48)}px` } : { left: '', top: '', right: '', bottom: '' });
    }
  };
  const draggable = (node, key) => {
    node.addEventListener('mousedown', (e) => { if (!e.button) badgeDrag = { node, key, x: e.clientX, y: e.clientY, r: node.getBoundingClientRect(), moved: false }; });
    node.addEventListener('click', (e) => { if (node.dataset.dragged) { delete node.dataset.dragged; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  };
  window.addEventListener('mousemove', (e) => {
    const d = badgeDrag; if (!d || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5)) return;
    d.moved = true;
    const right = Math.round(Math.min(Math.max(0, innerWidth - d.r.right - (e.clientX - d.x)), innerWidth - d.r.width));
    const bottom = Math.round(Math.min(Math.max(0, innerHeight - d.r.bottom - (e.clientY - d.y)), innerHeight - d.r.height));
    Object.assign(d.node.style, { left: 'auto', top: 'auto', right: `${right}px`, bottom: `${bottom}px` });
  }, true);
  window.addEventListener('mouseup', () => {
    const d = badgeDrag; badgeDrag = null; if (!d?.moved) return;
    d.node.dataset.dragged = '1'; setTimeout(() => delete d.node.dataset.dragged, 300);
    const look = d.node.classList.contains('is-icon') ? 'icon' : 'full';
    host.setConfig({ badgePos: { ...badgeCfg.badgePos, [`${d.key}-${look}`]: { right: parseFloat(d.node.style.right), bottom: parseFloat(d.node.style.bottom) } } });
  }, true);
  draggable(document.getElementById('listening-stop'), 'mic'); badgeLook();
  let mouse = null;
  const setInteractive = (on) => {
    if (on === interactive) return;
    interactive = on;
    host.setInteractive(on);
  };
  // Her dialogs (characters, voice, mic, settings, computer): while any is open the overlay takes
  // focus and clicks. Decided from all of them at once: one closing as another opens (Settings opening
  // the voice page) must not leave the open one unclickable.
  let dialogsOpen = false;
  const syncDialogs = () => queueMicrotask(() => {
    const open = Boolean(picker?.open || speechUI?.open || listeningUI?.open || settingsUI?.open || computerUI?.open);
    capri.pickerOpen = open;
    if (open !== dialogsOpen || open) host.focusOverlay(open);
    dialogsOpen = open;
    if (open) setInteractive(true); else refreshHit();
  });
  const onChip = () => Boolean(chip.visible && mouse && chip.contains(mouse.x, mouse.y, 0));
  const refreshHit = () => {
    if (picker?.open || speechUI?.open || listeningUI?.open || settingsUI?.open || computerUI?.open) return setInteractive(true);
    if (capri.dragging || badgeDrag) return setInteractive(true);
    if (!mouse) return setInteractive(false);
    const r = panel.rect();
    const onPanel = r && mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom;
    const stop = document.getElementById('speech-stop');
    const s = stop.getBoundingClientRect();
    const onSpeech = !stop.hidden && mouse.x >= s.left && mouse.x <= s.right && mouse.y >= s.top && mouse.y <= s.bottom;
    const micStop = document.getElementById('listening-stop'); const micRect = micStop.getBoundingClientRect();
    const onMic = !micStop.hidden && mouse.x >= micRect.left && mouse.x <= micRect.right && mouse.y >= micRect.top && mouse.y <= micRect.bottom;
    const mp=document.getElementById('mini-player'), mpRect=mp?.getBoundingClientRect();const onPlayer=mp&&!mp.hidden&&mouse.x>=mpRect.left&&mouse.x<=mpRect.right&&mouse.y>=mpRect.top&&mouse.y<=mpRect.bottom;
    const pcStop=document.getElementById('computer-stop'), pcRect=pcStop.getBoundingClientRect();const onComputer=!pcStop.hidden&&mouse.x>=pcRect.left&&mouse.x<=pcRect.right&&mouse.y>=pcRect.top&&mouse.y<=pcRect.bottom;
    document.body.style.cursor = onChip() ? 'pointer' : '';
    if (capri.ghost) return setInteractive(Boolean(onComputer || (document.body.classList.contains('ghost-badges') && (onSpeech || onMic || onPlayer))));
    return setInteractive(Boolean(onPanel || onSpeech || onMic || onComputer || onPlayer || capri.hit(mouse.x, mouse.y) || onChip()));
  };
  // Her place locked (her menu): she stays where she is; with lockDrag you can still put her elsewhere
  // Her place is kept per screen: lockAt = { [screen id]: { x, y } }, so each screen has its own
  let lockMap = {}, lockOn = false;
  const lockKey = () => String(screens?.current ?? 'main');
  const lockHere = () => { lockMap = { ...lockMap, [lockKey()]: { x: Math.round(capri.pos.x), y: Math.round(capri.pos.y) } }; host.setConfig({ lockAt: lockMap }); };
  const lockPlace = () => { const at = lockMap[lockKey()]; return at && { x: Math.min(at.x, innerWidth - 60), y: Math.min(at.y, capri.view.floor) }; };
  function lockLook(cfg, save = true) {
    lockMap = cfg.lockAt || {};
    capri.locked = Boolean(cfg.lockPos); capri.lockDrag = Boolean(cfg.lockDrag);
    if (save && capri.locked && !lockOn && !lockMap[lockKey()]) lockHere();
    lockOn = capri.locked;
  }
  window.addEventListener('mouseup', () => { if (capri.locked && capri.lockDrag && capri.dragging) setTimeout(lockHere, 1500); });
  // Out of sight, still working (her menu): nothing of her on screen, clicks go through, the mic and
  // player badges if you like. Something to answer (buttons), or ghostShow 'peek', brings her out a while.
  let ghostCfg = {}, peeking = false, peekTimer = 0;
  function ghostLook(cfg) {
    ghostCfg = cfg;
    if (!cfg.ghost) { clearInterval(peekTimer); peeking = false; }
    const on = Boolean(cfg.ghost) && !peeking;
    document.body.classList.toggle('ghost', on);
    document.body.classList.toggle('ghost-badges', cfg.ghostBadges !== false);
    capri.ghost = on;
    refreshHit();
  }
  function peekOut() {
    if (!ghostCfg.ghost) return;
    peeking = true; ghostLook(ghostCfg); clearInterval(peekTimer);
    let calm = 0;
    peekTimer = setInterval(() => {
      calm = speechUI.source || capri.busy || (panel.visible && !chat.open) ? 0 : calm + 1;
      if (calm >= 8) { clearInterval(peekTimer); peeking = false; ghostLook(ghostCfg); }
    }, 1000);
  }
  const panelSay = panel.say.bind(panel);
  panel.say = (msg) => { if (capri.ghost && (msg.actions?.length || ghostCfg.ghostShow === 'peek')) peekOut(); return panelSay(msg); };
  // Her biochip: her eyes on it follow the pointer over it, and she comes out when you click it
  // (only then, so the pointer passing through that corner doesn't call her back).
  // Her mask, asleep: the pointer coming over it stirs her, and a moment of that wakes her up.
  let wakeTimer = 0;
  const comeOut = () => {
    if (capri.stowed) host.setConfig({ visible: true }); // the tray and Ctrl+Alt+C follow
    capri.unstow();
  };
  const hoverChip = () => {
    chip.pointer = chip.visible && mouse && chip.contains(mouse.x, mouse.y) ? mouse : null;
    const near = mask.visible && mouse && mask.contains(mouse.x, mouse.y, 30);
    mask.pointer = near ? mouse : null;
    if (!near) {
      clearTimeout(wakeTimer);
      wakeTimer = 0;
    } else if (!wakeTimer) {
      wakeTimer = setTimeout(() => {
        wakeTimer = 0;
        if (capri.dormant) capri.wake();
      }, 400);
    }
  };
  let lastMove = performance.now();
  let onBack = null; // (away ms) => you're back at your PC after a while (the bond, below)
  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove > AWAY_MS) onBack?.(now - lastMove);
    lastMove = now;
    mouse = { x: e.clientX, y: e.clientY };
    refreshHit();
    hoverChip();
  });
  document.addEventListener('mouseleave', () => {
    mouse = null;
    refreshHit();
    hoverChip();
  });
  // Where the pointer really is, every couple of seconds: if it moved over her window and no
  // mousemove came, the hook that brings it to her is gone (Windows drops it without a word, after
  // sleep say), and main.js puts in a new one.
  let seen = null;
  let rearmedAt = -Infinity;
  let follow = null; // (pointer) => she may follow it to another screen (below)
  setInterval(async () => {
    const at = await host.cursor().catch(() => null);
    const before = seen;
    seen = at;
    follow?.(at);
    if (!at?.inside) return;
    const now = performance.now();
    // the pointer is on her and she isn't clickable (its moves stopped reaching her): she is now
    if (!interactive && now - lastMove > WATCH_MS) {
      mouse = { x: at.x, y: at.y };
      refreshHit();
    }
    if (!before?.inside || (at.x === before.x && at.y === before.y)) return;
    if (now - lastMove < WATCH_MS * 1.5 || now - rearmedAt < 20000) return;
    rearmedAt = now;
    host.rearm();
  }, WATCH_MS);
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (chip.visible && chip.contains(e.clientX, e.clientY, 0)) host.openMenu();
  });
  window.addEventListener('click', (e) => {
    if (chip.visible && chip.contains(e.clientX, e.clientY, 0)) comeOut();
  });
  // Ctrl + wheel over her: the next (down) or previous (up) character
  let wheelAt = 0;
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !capri.hit(e.clientX, e.clientY)) return;
    e.preventDefault();
    const list = characters, now = performance.now();
    if (now - wheelAt < 250 || list.length < 2) return;
    wheelAt = now;
    const i = list.findIndex((c) => c.id === capri.character.id);
    host.setConfig({ characterId: list[(i + (e.deltaY > 0 ? 1 : -1) + list.length) % list.length].id });
  }, { passive: false });

  // wiring
  capri.onMove = (head) => {
    // pointing at something: the panel goes on her other side, so it doesn't cover it
    panel.setAnchor({ ...head, lean: capri.pointing ? -capri.pointing.dir : 0 }, capri.view);
    // she may have moved out from under a still pointer: never leave a dead click zone behind
    refreshHit();
  };
  capri.onTeleport = (phase) => (phase === 'start' ? panel.suspend() : panel.resume());
  capri.chipAt = () => chip.center();
  capri.onStow = () => {
    chip.setMode(capri.mode);
    chip.show();
  };
  capri.onUnstow = () => chip.hide();
  capri.onDoze = (phase, face) => {
    if (phase === 'start') {
      mask.place(face.x, face.y, capri.scale * 1.1);
      mask.show();
    } else if (phase === 'waking') {
      mask.wake();
    } else {
      mask.hide();
    }
  };
  capri.onMode = (mode, prev) => chip.setMode(mode, prev);
  // now and then she says something about the satellite: while she looks at it, or once
  // the red light has gone up (never during, nothing should cover that)
  capri.onGaze = (when) => {
    const lines = when === 'end' ? brain.t.uplink : brain.t.gaze;
    if (!panel.visible && Math.random() < (when === 'end' ? 0.6 : 0.4)) panel.say({ kind: 'info', line: pick(lines), hold: 3800 });
  };
  panel.onChar = (kind) => voice.play('blip', { mood: kind });
  panel.onTalk = (talking, text) => {
    capri.lineTalking = talking;
    if (talking) { capri.talkLine = text || ''; capri.talkStarted = performance.now(); capri.perform('talk'); }
  };
  capri.onMenu = () => host.openMenu();

  // Her guide (guide.js): her welcome on first launch, and "How does it work?" in her menu,
  // where she takes you to things and points at them.
  // chat and guide let go of the keyboard when they close, but never from under an open dialog
  const keepFocus = { ...host, focusOverlay: (on) => host.focusOverlay(on || dialogsOpen) };
  const guide = new Guide({ capri, panel, voice, host: keepFocus, brain });
  // Talking to her (chat.js): "Talk to her" in her menu, or the button when you click her idle.
  const chat = new Chat({ capri, panel, voice, host: keepFocus, brain });
  let characterRequest = 0;
  const switchCharacter = async (character) => {
    const request = ++characterRequest;
    if (character.id === capri.character.id) return;
    try {
      const [nextImage, nextPortrait] = await loadCharacter(character);
      if (request !== characterRequest) return;
      chat.close();
      guide.answer(null);
      if (panel.current?.kind !== 'alert') panel.hide();
      capri.setCharacter(nextImage, character);
      brain.character = character;
      panel.labels = brain.t;
      chip.portrait = mask.portrait = character.renderer === 'capri' ? null : nextPortrait;
      identify(character);
      picker?.setCurrent(character.id);
      chat.history = [];
      chat.waitingWhen = null;
      // No reload: active coding sessions, position, scale and in-flight reactions survive.
    } catch (err) {
      if (request !== characterRequest) return;
      console.error('[companion] character load failed', err);
      host.setConfig({ characterId: capri.character.id });
      panel.say({ kind: 'error', line: brain.lang === 'th' ? 'โหลดตัวละครไม่สำเร็จ ใช้ตัวเดิมต่อ' : 'Could not load character; keeping the current one.', hold: 5000 });
    }
  };
  picker = new CharacterPicker({
    host,
    root: document.getElementById('character-picker'),
    characters: config.characters, currentId: config.characterId, lang: config.lang, scale: config.scale, framing: config.characterFraming,
    onChoose: async (characterId, display = {}) => {
      const patch = { ...display };
      if (characterId !== capri.character.id) patch.characterId = characterId;
      const cfg = await host.setConfig(patch);
      await switchCharacter(cfg.character);
      if (capri.character.id !== characterId) throw new Error('Character unavailable');
    },
    onVisibility: () => syncDialogs(),
  });
  speechUI = new Speech({ host, root: document.getElementById('speech-settings'), stopButton: document.getElementById('speech-stop'),
    lastReply: () => chat.history.findLast((message) => message.role === 'assistant')?.content || '',
    onVisibility: () => syncDialogs(),
  });
  speechUI.configure(config);
  capri.talk = () => listeningUI?.realtime?.active?listeningUI.realtime.level():speechUI.level();
  listeningUI = new Listening({ host, root: document.getElementById('listening-settings'), indicator: document.getElementById('listening-stop'), speech: speechUI, chat,
    onWake: () => { capri.wake(); if (capri.mode !== 'alert') capri.perform('curious', capri.towardCenter()); },
    onVisibility: () => syncDialogs(),
  });
  listeningUI.configure(config);
  settingsUI = new Settings({ host, root: document.getElementById('all-settings'),
    onOpen: (id) => ({ ai: () => setup.chat(), characters: () => picker.show(), speech: () => speechUI.show(), listening: () => listeningUI.show(), computer: () => computerUI.show(), customize: () => custom.open() })[id](),
    onVisibility: () => syncDialogs(),
    portrait: (character) => characterAsset(character, 'portrait'),
    runAI: (choice) => guide.scene(() => (choice === 'local' ? setup.ollama() : choice === 'key' ? setup.pickKeyed() : setup.use('pollinations'))),
    onTalk: () => chat.start(),
  });
  computerUI = new Computer({host,root:document.getElementById('computer-settings'),indicator:document.getElementById('computer-stop'),
    onVisibility: () => syncDialogs(),
    onStart:({voice})=>{if(!voice)listeningUI.stop();listeningUI.externalJob=voice;speechUI.stop();chat.close({keepListening:voice});panel.hide();picker.hide();speechUI.hide();listeningUI.hide();settingsUI.hide();},
    onPermission:request=>listeningUI.requestConfirmation(request),
    onQuestion:state=>{if(!state.voice)return false;if(listeningUI.realtime?.ask(state))return true;
      listeningUI.requestConfirmation({question:state.question,acceptYes:true,
        ...(state.answerNeeded?{clarify:answer=>computerUI.answerState(state,true,answer)}:{execute:()=>computerUI.answerState(state,true)}),
        cancel:()=>computerUI.answerState(state,false).catch(()=>{}),
      });return true;
    },
    onState:state=>{
      listeningUI.externalJob=state.voice&&['running','confirm'].includes(state.status);
      if(state.voice&&!['running','confirm'].includes(state.status)){
        listeningUI.clearConfirmation();listeningUI.followUntil=Date.now()+10000;
        listeningUI.speakFeedback(state.message).then(async()=>{while(speechUI.active)await new Promise(r=>setTimeout(r,100));if(listeningUI.settings?.mode==='push'&&!listeningUI.externalJob)listeningUI.releaseMic();});
      }
    },
  });
  listeningUI.realtime=new VoiceAgent({host,listening:listeningUI,speech:speechUI,computer:computerUI});
  listeningUI.realtime.configure(config);
  chat.onComputer = (text,options) => computerUI.request(text,options);
  // a job running: you can talk to her mid-job (not to answer a question she asked: that's its buttons)
  const tellJob = (text) => ['running'].includes(computerUI.state?.status) ? host.computerTell(text).catch(() => false) : false;
  chat.onJobTell = tellJob;
  listeningUI.onJobControl=async text=>{if(/^(?:หยุด(?:งาน|ทำงาน)?|ยกเลิก(?:งาน)?|stop|cancel)[.!\s]*$/i.test(text)){host.computerStop();speechUI.stop();}else if(await tellJob(text))listeningUI.setStatus('รับทราบ: '+text);else listeningUI.setStatus('กำลังทำงานอยู่ — พูดหยุดงานเพื่อยกเลิก');};
  chat.onStream = (id, text) => { if (!listeningUI.submitting) speechUI.feed(id, text); };
  chat.onReply = (text) => { if (capri.ghost && ghostCfg.ghostShow === 'peek') peekOut(); if (listeningUI.submitting) listeningUI.speakFeedback(text); else speechUI.reply(text); };
  chat.onSpeechStop = () => { listeningUI.endConversation(); };
  brain.onTalk = () => chat.start();
  // Getting her chat going with buttons (setup.js): Ollama and a model, a key, or an address
  const setup = new Setup({ guide, panel, host, brain, capri, voice });
  guide.setup = setup;
  guide.onTalk = () => chat.start();
  chat.onSetup = (status) => setup.chat(status);
  chat.onBetterModel = () => setup.better();
  setup.onReady = () => chat.start();
  // What she calls you, how she is, your lines, what she remembers (custom.js)
  const custom = new Custom({ guide, host, brain, capri, voice });
  guide.custom = custom;
  brain.custom = mine(config);

  // How close she is to you (bond.js), her jealousy of your other AIs, the reminders she keeps.
  const bond = new Bond({ host, data: config.bond });
  brain.bond = bond;
  chat.bond = bond;
  capri.fondness = bond.stage;
  const jealousy = new Jealousy({ capri, panel, brain, bond, chat, guide });
  jealousy.enabled = config.jealous !== false;
  chat.jealousy = jealousy;
  brain.onRival = (key) => jealousy.onRivalEvent(key);
  const reminders = new Reminders({ host, list: config.reminders || [] });
  chat.reminders = reminders;
  chat.onMessage = () => bond.add('chat', 2);
  // looking at your screen (look.js): when you ask, or now and then if you turned it on
  const look = new Look({ capri, panel, brain, chat, guide, host, fx, voice, active: () => performance.now() - lastMove });
  look.configure(config);
  chat.look = look; // "regarde mon écran" in her chat
  // your PC as she feels it (pc.js): the processor, the battery, the network, a USB stick, a game
  const pc = new Pc({ capri, panel, brain, host, voice, chat, guide });
  pc.enabled = config.pcReact !== false;
  let wantsOut = config.visible !== false; // not put away in your settings (Ctrl+Alt+C, her menu)
  pc.wantsOut = () => wantsOut;

  // Clicking her: what's going on, or she offers to talk. Sulking, she turns her back on you.
  capri.onClick = () => {
    if (panel.visible) panel.hide();
    else if (!jealousy.onClick()) {
      brain.status();
      bond.add('click', 1);
    }
  };

  // Thrown around (capri.js throwHer): she says how it was. The first time she's shaken (or she
  // loves it, once she's attached to you); twice in a row she's dizzy and fed up; three times in
  // two minutes she zaps your pointer and won't let you pick her up for a bit.
  const throws = [];
  capri.onThrown = ({ how, hard = 0 }) => {
    const t = brain.t.thrown;
    if (how === 'leap') {
      if (Math.random() < 0.4) panel.say({ kind: 'info', face: 'smug', line: pick(brain.t.screens.hello), hold: 3000 });
      return;
    }
    const now = performance.now();
    throws.push(now);
    while (throws.length && now - throws[0] > 120000) throws.shift();
    // how she says it, and how she feels about it after (her chat knows: bond.js)
    let line, face = 'smug', feel = null;
    if (throws.length >= 3) {
      throws.length = 0;
      line = pick(t.angry);
      face = 'many';
      feel = 'angry';
      capri.refuseUntil = now + 25000;
      bond.lose(1);
      if (mouse) capri.zap(mouse.x, mouse.y);
    } else if (how === 'ledge') line = pick(t.ledge);
    else if (how === 'feet') line = pick(t.feet);
    else if (throws.length === 2) {
      line = pick(t.again);
      face = 'aside';
      feel = 'dizzy';
    } else if (hard > 0.75 && Math.random() < 0.5) {
      line = pick(t.screen);
      face = 'laugh';
      feel = 'thrown';
    } else if (bond.stage >= 3) {
      line = pick(t.fun);
      face = 'laugh';
      feel = 'fun';
    } else {
      line = pick(t.ow);
      face = 'wide';
      feel = 'thrown';
    }
    if (feel && bond.feeling !== 'angry') bond.feel(feel);
    panel.say({ kind: 'info', face, line, hold: 3800 });
  };
  // you said sorry in her chat: she lets it go (and lets you pick her up again)
  bond.onCalm = () => {
    jealousy.forgive();
    capri.refuseUntil = 0;
  };
  capri.onDodge = () => panel.say({ kind: 'info', face: 'smug', line: pick(brain.t.thrown.dodge), hold: 2500 });

  // A new stage with you: her minds come out to look at you, and she says so, the sync bar under it.
  // At a quiet moment, so it isn't missed.
  let newStage = 0;
  bond.onStage = (stage) => {
    newStage = stage;
    capri.fondness = stage;
  };
  const quiet = () => !capri.busy && !capri.act && !capri.dragging && !capri.stowed && !capri.dormant && !capri.hidden
    && capri.mode !== 'alert' && !chat.open && !guide.running && !panel.visible && ['stand', 'sit'].includes(capri.stance);
  setInterval(async () => {
    if (!newStage || !quiet()) return;
    const stage = newStage;
    newStage = 0;
    const up = brain.t.bond.up[stage];
    if (!['angry', 'sulk'].includes(bond.feeling)) bond.feel('happy', { percent: bond.percent });
    voice.play('star');
    await capri.perform('split');
    capri.perform('hop');
    panel.say({
      kind: 'done', badge: `${brain.t.state.info} ${bond.percent}%`, face: stage >= 3 ? 'laugh' : 'look',
      line: fmt(up.line, { percent: bond.percent }), quote: up.quote, progress: bond.percent / 100, hold: 9000,
    });
  }, 3000);
  // time spent together: a little sync for every ten minutes you're at your PC with her out
  setInterval(() => {
    if (performance.now() - lastMove < 10 * 60 * 1000 && !capri.stowed) bond.add('time', 1);
  }, 10 * 60 * 1000);
  // back at your PC after a while: once she's attached to you, she's glad to see you
  onBack = () => {
    if (bond.stage < 2 || capri.stowed) return;
    capri.wake();
    setTimeout(() => {
      if (!quiet()) return;
      capri.perform('hop');
      panel.say({ kind: 'idle', face: 'look', line: pick(brain.t.bond.back), hold: 3500 });
    }, 700);
  };

  // A reminder due: she comes and finds you (on whichever screen you're on), and holds it up until
  // you say it's done or ask for ten more minutes. One that came due while she was off, she brings
  // up when she's back. Talking with her, it comes in the chat.
  const startedAt = Date.now();
  const remind = async (r) => {
    const t = brain.t.remind;
    const time = clock(r.at, brain.lang);
    const missed = r.at < startedAt - 60000;
    const line = missed
      ? fmt(r.text ? t.missed : t.missedBare, { text: r.text, time })
      : fmt(pick(r.text ? t.now : t.nowBare), { text: r.text });
    let answered = false;
    const onAction = (id) => {
      answered = true;
      if (id === 'snooze') {
        reminders.snooze(r.id, SNOOZE_MS);
        panel.setActions([]);
        if (chat.open) chat.interject(t.snoozed, [], null);
        else panel.say({ kind: 'info', face: 'smug', line: t.snoozed, hold: 2500 });
        return;
      }
      reminders.remove(r.id);
      bond.add('remind', 2);
      panel.setActions([]);
      if (chat.open) chat.interject(pick(t.doneLine), [], null);
      else panel.say({ kind: 'info', face: 'smug', line: pick(t.doneLine), hold: 2500 });
    };
    const actions = [{ id: 'done', label: t.done, primary: true }, { id: 'snooze', label: t.snooze }];
    voice.play('remind');
    for (let i = 0; chat.open && chat.turn && i < 60; i++) await wait(500); // her answer first
    if (chat.open && chat.interject(line, actions, onAction)) {
      // read in the chat: closed (or talked over) without a button, it counts as seen
      while (!answered && chat.open) await wait(1000);
      if (!answered) reminders.remove(r.id);
      return;
    }
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    await until(() => !capri.busy && !capri.dragging, 8000);
    await capri.toPointer(await host.cursor().catch(() => null));
    capri.perform('hop');
    const shownAt = performance.now();
    const shown = panel.say({
      kind: 'remind', face: 'look', line, quote: missed ? '' : fmt(t.asked, { time }), actions, onAction, hold: null,
      // closed without an answer: seen, if it was up long enough to read; else back in a couple of minutes
      onLeave: () => {
        if (answered) return;
        if (performance.now() - shownAt > 2500) reminders.remove(r.id);
        else reminders.snooze(r.id, 2 * 60 * 1000);
      },
    });
    if (!shown) reminders.snooze(r.id, 60 * 1000); // something more important on: in a minute
  };
  reminders.onDue = (r) => remind(r).catch((err) => {
    console.error('[capri] reminder', err);
    reminders.snooze(r.id, 60 * 1000);
  });
  // the first Claude Code event that ever reaches her: so you know it worked
  brain.linked = config.linked;
  brain.watching = config.claude !== false;
  brain.onLinked = () => {
    host.setConfig({ linked: true, welcomed: true });
    voice.play('hello');
    capri.perform('hop');
    panel.say({ kind: 'done', badge: 'LINK', line: brain.t.welcome.linked, hold: 6000 });
  };

  // The demo's second half, after its fake Claude session: everything she does on her own, one
  // after the other, a line before each.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (done, max = 15000) => {
    for (const t0 = Date.now(); !done() && Date.now() - t0 < max;) await wait(100);
  };
  const free = () => !capri.busy && !capri.act && capri.stance !== 'fall';
  brain.onShowcase = async () => {
    const t = brain.t.showcase;
    const caption = (line) => panel.say({ kind: 'info', line, hold: 2200 });
    capri.nextMove = capri.nextGaze = performance.now() + 120000; // nothing of her own in between
    if (capri.stowed) await capri.unstow();
    if (capri.dormant) capri.wake();
    await until(free);
    panel.hide();

    caption(t.minds);
    await wait(1000);
    await capri.perform('split');
    await wait(900);

    caption(t.zap);
    await wait(1000);
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    await wait(1800);

    panel.hide();
    if (capri.gaze({ big: true })) await until(() => !capri.sky);
    await wait(2500);

    // a little terminal opens for her to take over, and closes under her once she's done with it
    if (capri.possessWindows && (await host.demoWindow(true))) {
      const top = () => capri.windows.wins.find((w) => capri.canSit(w)); // it opens on top of everything
      await until(top, 4000);
      const win = top();
      const seat = win && { win, dx: win.w * 0.4 };
      if (seat) {
        panel.hide();
        await capri.sitOn(seat);
        await until(free);
        caption(t.possess);
        await wait(1400);
        panel.hide();
        await capri.possess();
        await wait(1800);
      }
      host.demoWindow(false);
      await wait(400);
      await until(free); // she may have fallen off it
      await wait(900);
    }

    caption(t.sleep);
    await wait(1400);
    panel.hide();
    capri.setMode('sleep');
    await wait(2500); // dozing off
    await capri.doze();
    await wait(4500);
    capri.wake();
    await until(free);
    await wait(1200);

    caption(t.chip);
    await wait(1600);
    panel.hide();
    await capri.stow();
    await wait(3500);
    await capri.unstow();
    await wait(600);
    panel.say({ kind: 'info', line: t.end, hold: 5000 });
  };

  // what's in here, for --dev scripts (debug route `eval`)
  // jobs from her main process that need Chromium: audio and video from your phone, decoded here
  host.onRpc(async ({ id, name, args }) => {
    try { host.rpcReply({ id, ok: true, value: await media[name](args) }); }
    catch (err) { host.rpcReply({ id, ok: false, error: err.message }); }
  });
  window.dev = { settings: settingsUI, computer:computerUI, voiceAgent:listeningUI.realtime, capri, brain, panel, chat, guide, fx, voice, bond, jealousy, reminders, look, pc, setup, picker, speech: speechUI, listening: listeningUI, screens: () => screens };

  host.onClaudeEvent((evt) => brain.handle(evt));
  host.onWindows((data) => {
    capri.setWindows(data);
    brain.onWindows(data);
    jealousy.onWindows(data);
    pc.onWindows(data);
  });
  // the windows as they are now: the watcher only speaks again when something changes
  host.windowsNow().then((data) => data && capri.setWindows(data));

  // her window resized, or moved to another screen (whose pixels may be another size)
  let dpr = window.devicePixelRatio;
  const applySize = ({ width, height, gap = 0 }) => {
    floorGap = gap;
    fx.resize(width, height);
    chip.place(width, height - gap);
    capri.setView(width, height, height - gap);
    if (window.devicePixelRatio !== dpr) {
      dpr = window.devicePixelRatio;
      capri.setScale(capri.scale); // her drawing redone at the new screen's pixels
    }
  };
  host.onResize(applySize);

  // Your screens. She goes from one to the other through their shared edge (thrown, or jumping
  // over to follow you), else in her column of light. `screens`: { current, origin (her window's
  // corner), list: [{ id, x, y, w, h }] }, all in the desktop's coordinates.
  let screens = await host.screens().catch(() => null);
  const refreshScreens = async () => {
    screens = await host.screens().catch(() => screens);
  };
  // the screen right past one side of hers (-1 left, 1 right), at height y of her window, if any
  const beyond = (side, y) => {
    const here = screens?.list.find((d) => d.id === screens.current);
    if (!here) return null;
    const gy = screens.origin.y + y;
    return screens.list.find((d) => d.id !== here.id && gy >= d.y && gy < d.y + d.h
      && (side > 0 ? Math.abs(d.x - (here.x + here.w)) <= 2 : Math.abs(d.x + d.w - here.x) <= 2)) || null;
  };
  const moveTo = async (id) => {
    const res = await host.moveScreen(id);
    if (!res) return null;
    screens = { ...screens, current: id, origin: res.origin };
    applySize(res);
    return res;
  };
  capri.canCross = (side, y) => Boolean(beyond(side, y));
  capri.onCross = async (side, at) => {
    const there = beyond(side, at.y);
    if (!there) return null;
    const gy = screens.origin.y + at.y;
    const res = await moveTo(there.id);
    return res && { y: gy - res.origin.y };
  };
  capri.onScreenOf = (cursor) => !capri.locked && capri.jumpScreen(async () => {
    await moveTo(cursor.display);
    return host.cursor();
  }, { toPointer: true });
  // to screen `id`: jumping over the shared edge if there's one at her height, else teleporting
  const goToScreen = async (id) => {
    if (!screens || id === screens.current) return;
    const mid = capri.screenPoint(118, 232);
    const side = [-1, 1].find((s) => beyond(s, Math.max(120, mid.y - 140))?.id === id);
    if (side && (await capri.leapTo(side))) return;
    await capri.jumpScreen(async () => {
      await moveTo(id);
      return host.cursor();
    });
  };
  // locked: picked in her menu, she goes (it's you asking) and settles where that screen's lock is (first time: where she lands)
  const goToScreenLocked = async (id) => {
    const unlock = capri.locked; capri.locked = false;
    try { await goToScreen(id); } finally { capri.locked = unlock; }
    if (!capri.locked) return;
    const at = lockPlace();
    if (at) await capri.teleport(at, { force: true }); else lockHere();
  };
  // The pointer on another of your screens for a few seconds: she follows you there, when she's
  // free to (not in the middle of something, not asleep, not put away).
  let followOn = config.follow !== false;
  let awayChecks = 0;
  follow = (at) => {
    const elsewhere = followOn && screens && screens.list.length > 1 && at && !at.inside && at.display != null && at.display !== screens.current;
    awayChecks = elsewhere ? awayChecks + 1 : 0;
    if (awayChecks < FOLLOW_AFTER) return;
    if (capri.busy || capri.dragging || capri.stowed || capri.locked || capri.ghost || capri.dormant || capri.hidden || capri.act || capri.pointing) return;
    if (!['stand', 'sit'].includes(capri.stance) || capri.mode === 'sleep' || capri.mode === 'alert' || chat.open || guide.running) return;
    awayChecks = 0;
    goToScreen(at.display);
  };
  window.addEventListener('resize', () => {
    badgeLook();
    fx.resize(innerWidth, innerHeight);
    chip.place(innerWidth, innerHeight - floorGap);
    capri.setView(innerWidth, innerHeight, innerHeight - floorGap);
  });

  host.onConfig((cfg) => {
    badgeCfg = cfg; badgeLook();
    speechUI.configure(cfg);
    listeningUI.realtime.configure(cfg);
    listeningUI.configure(cfg);
    picker?.setCharacters(cfg.characters);
    characters = cfg.characters || characters;
    picker?.setDisplay(cfg.scale, cfg.characterFraming);
    voice.configure(cfg);
    jealousy.enabled = cfg.jealous !== false;
    followOn = cfg.follow !== false;
    look.configure(cfg);
    pc.enabled = cfg.pcReact !== false;
    wantsOut = cfg.visible !== false;
    reminders.sync(cfg.reminders); // one may have been cancelled from her menu
    capri.wander = cfg.wander;
    lockLook(cfg); ghostLook(cfg);
    capri.possessWindows = cfg.possess;
    capri.restOn = cfg.rest || 'corner';
    applyMotion(cfg.motion);
    if ((cfg.claude === false && brain.watching) || cfg.assistant !== brain.assistant) {
      guide.answer(null);
      panel.hide();
      capri.stopPointing();
      brain.replyFor = null;
      brain.linked = cfg.linked;
      // no longer watching Claude Code: whatever it was in the middle of is no business of hers
      brain.sessions.clear();
      panel.setTicker(null);
      if (capri.mode === 'work' || capri.mode === 'alert') capri.setMode('idle');
    }
    brain.watching = cfg.claude !== false;
    brain.custom = mine(cfg);
    brain.assistant = cfg.assistant;
    panel.labels = linesFor(cfg.lang, cfg.assistant, brain.character);
    switchCharacter(cfg.character);
    if (cfg.scale !== capri.scale) capri.setScale(cfg.scale);
    if (cfg.characterFraming !== capri.framing) capri.setFraming(cfg.characterFraming);
    if (cfg.lang !== brain.lang) {
      // Recreate open guides and chat controls too, so no old-language buttons remain.
      window.location.reload();
      return;
    }
  });

  host.onCommand(async (cmd) => {
    if(cmd.name==='voice-agent-stop'){listeningUI.realtime.stop();return;}
    if (cmd.name === 'listening') { picker.hide(); speechUI.hide(); await listeningUI.show(); return; }
    // from her menu or the hotkey: the mic starts as set, no dialog (it opens only if something's missing)
    if (cmd.name === 'listening-toggle') { if (!listeningUI.settings) await listeningUI.load(); await listeningUI.toggle(); return; }
    if (cmd.name === 'listening-mode') {
      if (!listeningUI.settings) await listeningUI.load();
      listeningUI.stop(); listeningUI.mode.value = cmd.mode;
      await listeningUI.begin().catch((e) => listeningUI.error(e));
      return;
    }
    if (cmd.name === 'listening-stop') { listeningUI.stop(); return; }
    if (cmd.name === 'characters' || cmd.name === 'speech') { listeningUI.stop(); listeningUI.hide(); }
    if (cmd.name === 'ask-value') { // a value typed in her panel: VIP senders, a routine, LINE
      const got = await guide.askText({ face: 'look', line: cmd.title, quote: cmd.hint, secret: Boolean(cmd.secret), placeholder: cmd.value || cmd.hint });
      if (got?.text === undefined || got?.text === null) return;
      try { panel.say({ kind: 'info', line: `${cmd.title}: ${await host.setValue(cmd.key, got.text)}`, hold: 6000 }); }
      catch (err) { panel.say({ kind: 'error', line: err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), hold: 9000 }); }
      return;
    }
    if (cmd.name === 'news-list') { // a list in her News tab: topics, alert words, feeds, outlets to skip
      const got = await guide.askText({ face: 'look', line: cmd.title, quote: cmd.hint, placeholder: cmd.value || cmd.hint });
      if (got?.text === undefined || got?.text === null) return;
      try { const list = await host.newsSet(cmd.key, got.text); panel.say({ kind: 'info', line: `${cmd.title}: ${list.join(', ') || '—'}`, hold: 5000 }); }
      catch (err) { panel.say({ kind: 'error', line: err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), hold: 8000 }); }
      return;
    }
    if (cmd.name === 'telegram-pin') { // the PIN your phone adds to risky commands (/pr 1234)
      const got = await guide.askText({ face: 'look', line: 'ตั้ง PIN 4–8 หลัก', quote: 'ใช้ต่อท้ายคำสั่งเสี่ยงจาก Telegram เช่น /pr 1234 · เก็บแบบแฮช ไม่เก็บตัวเลขจริง', secret: true, placeholder: '1234' });
      if (!got?.text) return;
      try { await host.telegramPin(got.text.trim()); panel.say({ kind: 'info', line: 'ตั้ง PIN แล้ว', hold: 5000 }); }
      catch (err) { panel.say({ kind: 'error', line: err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), hold: 8000 }); }
      return;
    }
    if (cmd.name === 'telegram-token') { // her Telegram bot's token, pasted in her panel
      const got = await guide.askText({ face: 'look', line: 'วาง bot token จาก @BotFather', quote: 'หน้าตาแบบ 123456789:AA… · ฉันเก็บแบบเข้ารหัสในเครื่อง', secret: true, placeholder: '123456789:AA…' });
      if (!got?.text) return;
      try { const bot = await host.telegramToken(got.text); panel.say({ kind: 'info', line: `เชื่อม @${bot} แล้ว ต่อไปกด "ผูกกับแชตของคุณ…" ในแท็บ Telegram`, hold: 8000 }); }
      catch (err) { panel.say({ kind: 'error', line: err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), hold: 9000 }); }
      return;
    }
    if (cmd.name === 'assistant-alert') { // her assistant: important mail, a meeting soon, or how setup went
      const link = cmd.link && /^https:\/\//.test(cmd.link) ? cmd.link : '';
      if (cmd.kind === 'mail' || cmd.kind === 'event') {
        voice.play('remind'); capri.wake();
        const line = cmd.kind === 'mail' ? `📧 เมลสำคัญจาก ${cmd.from.replace(/<[^>]*>/, '').trim() || 'ไม่ทราบชื่อ'}` : `📅 อีก ${cmd.minutes} นาที: ${cmd.summary}`;
        const asks = cmd.kind === 'mail'
          ? { sum: ['สรุปให้', `สรุปเมล id ${cmd.id} (จาก ${cmd.from}) ให้หน่อย และบอกว่าต้องทำอะไรต่อไหม`], reply: ['ร่างตอบ', `ร่างคำตอบเมล id ${cmd.id} (จาก ${cmd.from}) ให้หน่อย ยังไม่ต้องส่ง`], task: ['เพิ่มเป็นงาน', `อ่านเมล id ${cmd.id} แล้วเพิ่มสิ่งที่ฉันต้องทำลงรายการงาน`] }
          : { late: ['เลื่อน 15 นาที', `เลื่อนนัด "${cmd.summary}" (event id ${cmd.id}) ออกไป 15 นาที`] };
        const actions = [...(link ? [{ id: 'open', label: cmd.kind === 'mail' ? 'เปิดเมล' : /meet|zoom|teams/.test(link) ? 'เข้าประชุม' : 'ดูนัด', primary: true }] : []), ...Object.entries(asks).map(([id, [label]]) => ({ id, label })), { id: 'ok', label: 'รับทราบ' }];
        panel.say({ kind: 'remind', face: 'look', line, quote: cmd.kind === 'mail' ? cmd.subject : cmd.prep || '', actions, hold: null, onAction: async (id) => {
          panel.hide();
          if (id === 'open') host.openSite(link);
          else if (asks[id]) { await chat.start(); chat.send(asks[id][1]); }
        } });
      } else if (cmd.kind === 'news' || cmd.kind === 'brief') { // a summary: in her bubble, and aloud if you like
        voice.play('remind'); capri.wake();
        const first = cmd.link || cmd.links?.[0]?.link;
        const actions = [{ id: 'read', label: 'อ่านให้ฟัง' }, ...(first ? [{ id: 'open', label: 'เปิดข่าว' }] : []), { id: 'ok', label: 'รับทราบ', primary: true }];
        panel.say({ kind: 'remind', face: 'smug', line: cmd.title, quote: cmd.text, actions, hold: null, onAction: (id) => { if (id === 'read') speechUI.play(`${cmd.title.replace(/^\W+/u, '')}. ${cmd.text}`).catch(() => {}); else if (id === 'open') host.openSite(first); if (id !== 'read') panel.hide(); } });
        if (cmd.kind === 'brief' && (await host.getConfig()).briefs?.voice !== false) speechUI.play(cmd.text).catch(() => {});
      } else if (cmd.kind === 'phone') { // asked from Telegram: her answer here too, aloud
        capri.wake();
        panel.say({ kind: 'info', line: `📱 ${cmd.question.slice(0, 80)}`, quote: cmd.text, hold: 12000 });
        speechUI.play(cmd.text).catch(() => {});
      } else panel.say({ kind: cmd.kind === 'error' ? 'error' : 'info', line: cmd.message, hold: cmd.kind === 'error' ? 9000 : 6000 });
      return;
    }
    if (cmd.name === 'mcp-confirm') { // a tool that writes, sends or deletes: your yes first
      const actions = [{ id: 'yes', label: `อนุญาต: ${cmd.tool}${cmd.detail ? ` (${cmd.detail.slice(0, 70)})` : ''}`, primary: true }, { id: 'no', label: 'ไม่ต้อง' }];
      const onAction = (id) => { host.mcpAnswer(cmd.id, id === 'yes'); panel.setActions([]); };
      if (chat.open) panel.setActions(actions, onAction);
      else panel.say({ kind: 'remind', face: 'look', line: `ให้ฉันใช้ ${cmd.tool} ไหม?`, quote: cmd.detail, actions, onAction, hold: null });
      return;
    }
    if (cmd.name === 'now-playing') { // her mini player: the song, its buttons; she dances while it plays
      let mp = document.getElementById('mini-player');
      if (!mp) {
        mp = document.createElement('div'); mp.id = 'mini-player'; mp.setAttribute('role', 'region'); mp.setAttribute('aria-label', 'มินิเพลเยอร์');
        mp.innerHTML = '<span class="mp-note" aria-hidden="true">♪</span><span class="mp-text"></span><button type="button" data-a="previous" aria-label="เพลงก่อนหน้า">⏮</button><button type="button" data-a="pause" aria-label="เล่นหรือหยุด">⏯</button><button type="button" data-a="next" aria-label="เพลงถัดไป">⏭</button>';
        for (const ev of ['mousedown', 'mouseup', 'click']) mp.addEventListener(ev, (e) => e.stopPropagation());
        mp.addEventListener('click', (e) => { const a = e.target.dataset?.a || (mp.classList.contains('is-icon') && 'pause'); if (a) host.media(a); });
        document.body.append(mp); draggable(mp, 'player'); badgeLook();
      }
      const on = Boolean(cmd.title), playing = on && String(cmd.status || '').toLowerCase() === 'playing';
      mp.hidden = !on; mp.classList.toggle('is-playing', playing);
      mp.querySelector('.mp-text').textContent = mp.title = on ? `${cmd.title}${cmd.artist ? ` — ${cmd.artist}` : ''}` : '';
      clearInterval(window.__uncleMusicDance);
      capri.musicPlaying=playing;
      if (!playing) capri.danceSuppressed=false;
      capri.musicDance=playing && !capri.danceSuppressed;
      return;
    }
    if (cmd.name === 'computer-cursor') { // her own cursor glides there just before she clicks
      let c = document.getElementById('her-cursor');
      if (!c) { c = document.createElement('div'); c.id = 'her-cursor'; c.setAttribute('aria-hidden', 'true'); document.body.append(c); }
      c.style.left = `${cmd.x}px`; c.style.top = `${cmd.y}px`; c.classList.add('is-on');
      clearTimeout(c.timer); c.timer = setTimeout(() => c.classList.remove('is-on'), 2500);
      return;
    }
    if(cmd.name==='computer-companion'){
      const action=cmd.action;
      if(action==='sleep')capri.setMode('sleep');
      else if(action==='wake')capri.wake();
      else if(action==='come_here')await capri.toPointer(await host.cursor());
      else if(action==='next_monitor'){const list=await host.screens();const next=list?.list?.find(d=>d.id!==list.current);if(next)goToScreen(next.id);}
      else if(action==='sit'){const seat=capri.pickSeat();if(seat)capri.sitOn(seat);else capri.arrive(capri.pos,{stance:'sit'});}
      else if(action==='stand')await capri.arrive(capri.pos,{stance:'stand'});
      else if(action==='hang')await capri.peek('top');
      else if(action==='ride_cursor'){clearInterval(window.__uncleRide);window.__uncleRide=setInterval(async()=>{if(capri.dragging){clearInterval(window.__uncleRide);return;}const cursor=await host.cursor();if(cursor?.inside)capri.pos={x:cursor.x+30,y:cursor.y+30};},80);}
      else if(action==='leave_cursor')clearInterval(window.__uncleRide);
      else if(action==='dance'){clearInterval(window.__uncleDance);capri.danceSuppressed=false;capri.musicDance=Boolean(capri.musicPlaying);}
      else if(action==='stop_dance'){clearInterval(window.__uncleDance);clearInterval(window.__uncleMusicDance);capri.danceSuppressed=true;capri.musicDance=false;}
      else if(action==='idle')capri.setMode('idle');
      else if(action==='smile')capri.perform('victory');
      else if(action==='blink')capri.perform('look');
      else if(action==='glitch')capri.perform('split');
      return;
    }
    if (cmd.name === 'computer') {picker.hide();speechUI.hide();listeningUI.hide();settingsUI.hide();await computerUI.show();return;}
    if (cmd.name === 'settings') { picker.hide(); speechUI.hide(); listeningUI.hide(); await settingsUI.show(cmd.tab); return; }
    const t = brain.t;
    switch (cmd.name) {
      case 'characters':
        speechUI.hide();
        picker.show();
        break;
      case 'speech':
        picker.hide();
        speechUI.show();
        break;
      case 'teleport':
        capri.teleport(capri.spot('random'));
        break;
      case 'status':
        brain.status();
        break;
      case 'customize': // "Make her yours" in her menu
        custom.open();
        break;
      case 'setupChat': // "Set it up with her" in her menu's AI model
        setup.chat();
        break;
      case 'setupKey': // "API key or address" in her menu's AI model, or a service picked there that needs one
        setup.key();
        break;
      case 'setupFree': // --dev: Claude Code (or Codex) through Ollama
        setup.free();
        break;
      case 'setupStep': // --dev: one step of her setup on its own (pickModel, pull, pickKeyed, address…)
        guide.scene(() => setup[cmd.step]?.(...(cmd.args || [])));
        break;
      case 'look': // "Look at my screen" in her menu: once, now
        look.once();
        break;
      case 'watchScreen': // "Look at my screen now and then" in her menu
        look.setAuto(cmd.on);
        break;
      case 'goScreen': // a screen picked in her menu: she goes there
        (capri.locked ? goToScreenLocked : goToScreen)(cmd.id);
        break;
      case 'screens': // a screen plugged in, unplugged or moved
        refreshScreens();
        break;
      case 'remindIn': // --dev: a reminder `ms` from now
        reminders.add(Date.now() + (cmd.ms ?? 3000), cmd.text ?? '');
        break;
      case 'bond': // --dev: sync points from a source (as if earned)
        bond.add(cmd.source || 'chat', cmd.n || 1);
        break;
      case 'rearmed': // a new mouse hook (main.js): click-through until the pointer comes over her again
        mouse = null;
        refreshHit();
        break;
      case 'rearm': // --dev: as if she'd noticed the pointer no longer reaches her
        host.rearm();
        break;
      case 'loseGl': { // --dev: as if the GPU had been reset (waking from sleep): she goes, then comes back
        const lose = capri.sprite.gl?.getExtension('WEBGL_lose_context');
        lose?.loseContext();
        setTimeout(() => lose?.restoreContext(), cmd.ms ?? 1500);
        break;
      }
      case 'answer': { // --dev: as if that button of her panel had been clicked (her chat's too)
        const button = document.querySelector(`.panel__action[data-id="${CSS.escape(cmd.id)}"]`);
        if (button) button.click();
        else guide.answer(cmd.id);
        break;
      }
      case 'assistantChanged': // Claude Code, Codex or Antigravity, picked in her menu
        guide.welcome();
        break;
      case 'welcome': // "How does it work?" in her menu
        guide.menu();
        break;
      case 'forget': // "Forget our conversations" in her menu, maybe with her chat open
        chat.history = [];
        break;
      case 'chat': // "Talk to her" in her menu
        chat.start();
        break;
      case 'report': // "Mission report" in her menu
        if (capri.stowed) {
          host.setConfig({ visible: true });
          await capri.unstow();
        }
        capri.wake();
        if (brain.report()) capri.perform('curious', capri.towardCenter());
        break;
      case 'fakeClaude': { // --dev: the topmost window (the test window) is where a prompt was typed, and you're elsewhere
        const win = capri.windows.wins[0];
        if (win) {
          brain.sessions.set('dev', { id: 'dev', project: 'dev', taskStart: Date.now(), count: 0, files: new Set(), log: [], working: true, waiting: false, window: win.id, seen: Date.now() });
          capri.windows = { ...capri.windows, fg: -1 };
        }
        break;
      }
      case 'guide': // --dev: one topic of her guide (welcome, menu, connect, icon, claude, folder)
        if (cmd.topic === 'welcome') guide.welcome();
        else if (cmd.topic === 'menu') guide.menu();
        else if (typeof guide[cmd.topic] === 'function') guide.scene(() => guide[cmd.topic]());
        break;
      case 'stow': // Ctrl+Alt+C: into her biochip, or back out
        if (cmd.on) capri.stow();
        else capri.unstow();
        break;
      case 'satellite': // the whole sequence, on demand (tray)
        if (capri.stowed) {
          host.setConfig({ visible: true });
          await capri.unstow();
        }
        capri.wake();
        if (capri.stance === 'peek') await capri.unpeek();
        if (!capri.gaze({ big: true })) setTimeout(() => capri.gaze({ big: true }), 1500);
        break;
      case 'update': // a new version downloaded (main.js): now, or when she quits
        panel.say({
          kind: 'info', face: 'smug', hold: null,
          line: brain.lang === 'th' ? `มีเวอร์ชันใหม่ ${cmd.version} แล้วนะ${cmd.download ? '' : ' โหลดเสร็จแล้ว'}` : `Version ${cmd.version} is ${cmd.download ? 'out' : 'ready'}.`,
          // on a Mac (not signed by Apple) she can't install it herself: the button opens the download page
          actions: [{ id: 'now', label: cmd.download ? (brain.lang === 'th' ? 'ดาวน์โหลดเวอร์ชันใหม่' : 'Download it') : (brain.lang === 'th' ? 'รีสตาร์ทเพื่ออัปเดต' : 'Restart to update'), primary: true }, { id: 'later', label: brain.lang === 'th' ? 'ไว้ทีหลัง' : 'Later' }],
          onAction: (id) => (id === 'now' ? host.installUpdate() : panel.hide()),
        });
        break;
      case 'hooks':
        if (cmd.ok) panel.say({ kind: 'info', line: cmd.action === 'install' ? t.hooksOk : t.hooksRemoved, hold: 6000 });
        else panel.say({ kind: 'error', line: fmt(t.hooksFail, { error: cmd.error }), hold: 9000 });
        break;
      // --dev helpers
      case 'pose':
        capri.debug = cmd.params || null;
        if (cmd.still) capri.nextMove = capri.nextGaze = Infinity; // no wandering off mid-test
        if (cmd.hush) {
          panel.setTicker(null);
          panel.hide();
        }
        if (cmd.scale) capri.setScale(cmd.scale);
        if (cmd.stance) capri.setStance(cmd.stance, cmd);
        if (cmd.at) capri.pos = cmd.at;
        if (cmd.facing) capri.facing = cmd.facing;
        capri.drawFrame();
        break;
      case 'config': // a setting, as if changed from her menu
        host.setConfig(cmd.patch || {});
        break;
      case 'focus': // as if window `fg` had come to the front
        capri.windows = { ...capri.windows, fg: cmd.fg };
        brain.onWindows(capri.windows);
        break;
      case 'freeze':
        capri.hidden = Boolean(cmd.on);
        break;
      case 'act':
        // behaviours by method name (gaze, celebrate, hurt, shed, peek, fall, wanderStep...) or acts by name
        if (cmd.act === 'sit') {
          // pile: n-th window she could sit on from the top of the pile (0: the --dev test window
          // opened last), instead of the usual choice
          const top = cmd.pile !== undefined && capri.windows.wins.filter((w) => capri.canSit(w))[cmd.pile];
          const seat = top ? { win: top, dx: top.w * 0.4 } : capri.pickSeat();
          if (seat) capri.sitOn(seat);
        } else if (typeof capri[cmd.act] === 'function') capri[cmd.act](...(cmd.args || []));
        else capri.perform(cmd.act, cmd.dir || 0);
        break;
      default:
        break;
    }
  });

  // entrance: her face big in the corner says hi, then she dives down to her spot
  // (put away last time: she starts in her biochip)
  lockLook(config, false); ghostLook(config);
  if (config.visible === false) capri.stowNow();
  else await capri.materialize((capri.locked && lockPlace()) || capri.spot('post'));
  if (capri.locked && !lockPlace()) lockHere(); // locked, and this screen has no place yet: where she landed
  // Windows has its animations off and she's following it: she barely moves. The first time, she
  // says so and asks whether to move anyway (her menu › Animations changes it later).
  if (reducedMotion.setting === 'auto' && reducedMotion.system && !config.motionAsked) {
    const m = brain.t.motion;
    await new Promise((done) => {
      const asked = panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: m.line,
        quote: m.quote,
        actions: [{ id: 'full', label: m.full, primary: true }, { id: 'reduced', label: m.still }],
        onAction: (id) => {
          host.setConfig({ motion: id, motionAsked: true });
          panel.hide();
          if (id === 'full') capri.perform('hop');
        },
        onLeave: done,
        hold: null,
      });
      if (!asked) done();
    });
  }
  const hooks = await host.hooksStatus();
  // her welcome: the first time, or while she's meant to watch Claude Code and isn't plugged into it
  // first launch: her setup, step by step (settings.js); later, her welcome while Claude Code isn't plugged in
  if (!config.welcomed) settingsUI.show();
  else if (config.claude && !hooks.installed) guide.welcome();
  else panel.say({ kind: 'info', line: brain.onlineLine(), hold: 4000 });

  // In the evening, after a real day's work, she brings you her report card once, on her own,
  // at a quiet moment.
  setInterval(() => {
    const day = mission.day;
    const quiet = !brain.busySessions.length && !panel.visible && !guide.running && !capri.busy && !capri.act;
    if (new Date().getHours() < 18 || day.reported || day.missions < 3 || !quiet) return;
    if (capri.stowed || capri.dormant || capri.mode === 'sleep') return;
    if (brain.report()) {
      mission.markReported();
      capri.perform('curious', capri.towardCenter());
    }
  }, 60000);
}

boot().catch((err) => {
  console.error('[capri] boot failed', err);
});
