import { clamp, lerp, reducedMotion } from './util.js';
import { SpriteRenderer, SPRITE as CAPRI } from './sprite.js';
import { dimensions, atlasRect, chooseVariant, gpuTextureLimit, atlasCache, assetURL } from './character-assets.js';
import { CharacterRig, trackFrame, applyPose } from './character-rig.js';
import { ConversationMotion } from './conversation-motion.js';
import { TorsoMotion, drawTorsoMotion, torsoRegions } from './torso-motion.js';

// Lachy's Capri sprite strips; attribution and license are in assets/capri/strips/NOTICE.txt.
export const CAPRI_STRIPS = {
  idle: { count: 16, fps: 8, scale: 1.11, anchor: 'feet' },
  mouth: { count: 5, fps: 12, scale: 1.11, anchor: 'feet' },
  dangle: { count: 24, fps: 10, scale: 1.11, anchor: 'feet' },
  sleep: { count: 16, fps: 6, scale: 1.11, anchor: 'feet' },
  perch: { count: 16, fps: 8, scale: 1, anchor: 'seat', seat: 0.79 },
  walk: { count: 12, fps: 12, scale: 1.11, anchor: 'feet' },
  dance: { count: 16, fps: 12, scale: 1.11, anchor: 'feet' },
  wake: { count: 13, fps: 15, scale: 1.11, anchor: 'feet' },
  glitch: { count: 10, fps: 15, scale: 1.11, anchor: 'feet' },
  grin: { count: 16, fps: 8, scale: 1.11, anchor: 'feet' },
  arrive: { count: 14, fps: 15, scale: 1.11, anchor: 'feet' },
  leave: { count: 12, fps: 15, scale: 1.11, anchor: 'feet' },
  perch_blink: { count: 4, fps: 8, scale: 1, anchor: 'seat', seat: 0.79 },
  perch_blink_glitch: { count: 4, fps: 8, scale: 1, anchor: 'seat', seat: 0.79 },
  perch_glitch: { count: 10, fps: 15, scale: 1, anchor: 'seat', seat: 0.79 },
  perch_dance: { count: 16, fps: 12, scale: 1, anchor: 'seat', seat: 0.79 },
  perch_arrive: { count: 14, fps: 15, scale: 1, anchor: 'seat', seat: 0.79 },
  perch_leave: { count: 12, fps: 15, scale: 1, anchor: 'seat', seat: 0.79 },
};

export function capriStripFor({ stance, mode, act, reaction, dance, clip }, still = false) {
  if (still || mode === 'alert' || reaction) return null;
  if (stance === 'fly' || stance === 'fall' || stance === 'down' || stance === 'peek') return null;
  if (clip && CAPRI_STRIPS[clip]) return clip;
  if (stance === 'held') return 'dangle';
  if (act && act !== 'talk') return null;
  if (dance && mode === 'idle') return stance === 'sit' ? 'perch_dance' : 'dance';
  if (stance === 'sit') return 'perch';
  if (stance !== 'stand') return null;
  return mode === 'sleep' ? 'sleep' : 'idle';
}

// Text-based mouth approximation from the Capri strip renderer; Thai letters flap.
export function capriMouthCell(text, elapsed) {
  const step = Math.floor(Math.max(0, elapsed) * 12 / 1000);
  const chars = [...String(text || '')];
  const ch = chars[Math.floor(step / 12 * 28)];
  if (!ch) return step % 2 ? 1 : 2;
  const lower = ch.toLowerCase();
  if ('aeo'.includes(lower)) return ch === lower ? 3 : 4;
  if ('iuy'.includes(lower)) return 2;
  if ('mbp'.includes(lower) || !/\p{L}/u.test(ch)) return 0;
  return step % 2 ? 1 : 2;
}

function loadCapriStrip(name) {
  const spec = CAPRI_STRIPS[name];
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      if (!image.width || image.width % spec.count || !image.height || image.width * image.height * 4 > 32 * 1024 * 1024) return resolve(null);
      const width = image.width / spec.count;
      try {
        const frames = Array.from({ length: spec.count }, (_, i) => {
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = image.height;
          canvas.getContext('2d').drawImage(image, i * width, 0, width, image.height, 0, 0, width, image.height);
          return canvas;
        });
        resolve({ frames, width, height: image.height, bytes: image.width * image.height * 4 });
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = `../../assets/capri/strips/${name}.png`;
  });
}

// Use one coordinate system for drawing, dragging, collision and effect anchors.
export const SPRITE = {
  width: 320, height: 420, pad: 56,
  head: { x: 160, y: 110 }, feet: { x: 160, y: 418 }, hip: 270,
  shoulder: { x: 120, y: 220 }, hand: { x: 35, y: 250 }, mirror: 320,
};

// Small audio-driven body motion complements authored mouth frames; older
// character atlases still use this as their speech feedback.
function talkStretch(ctx, renderer, talk = 0) {
  renderer.talk = reducedMotion.matches ? 0 : lerp(renderer.talk || 0, talk, 0.5);
  if (renderer.talk < 0.01) return;
  const x = SPRITE.pad + SPRITE.feet.x, y = SPRITE.pad + SPRITE.feet.y;
  ctx.translate(x, y);
  ctx.scale(1 - renderer.talk * 0.015, 1 + renderer.talk * 0.03);
  ctx.translate(-x, -y);
}

export const ANIMATION_ROWS = Object.freeze({ idle: 0, thinking: 1, attention: 2, success: 3, error: 4, sleep: 5 });

// Blend only pose changes. This cannot invent intermediate limb geometry.
export function poseBlend(elapsed, still = false, duration = 180) {
  return still ? 0 : 1 - clamp(elapsed / clamp(duration, 40, 250), 0, 1);
}

export function animationFor({ mode = 'idle', act = '', reaction = '' } = {}) {
  if (mode === 'alert') return 'attention';
  if (reaction) return reaction;
  if (['flinch', 'glare', 'sulk', 'ko'].includes(act)) return 'error';
  if (['victory', 'hop'].includes(act)) return 'success';
  if (mode === 'sleep') return 'sleep';
  if (mode === 'work' || ['curious', 'look', 'gaze'].includes(act)) return 'thinking';
  return 'idle';
}

export function frameFor(state, elapsed, fps = 4, still = false) {
  const row = ANIMATION_ROWS[state] ?? ANIMATION_ROWS.idle;
  const step = Math.max(0, Math.floor(elapsed * fps / 1000));
  // Keep most of the idle cycle open-eyed; blinking should be occasional.
  const idle = [0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 3, 0];
  const column = still ? 0 : state === 'idle' ? idle[step % idle.length] : step % 4;
  return row * 4 + column;
}

export function sourceRect(character, framing = 'full') {
  return framing === 'bust'
    ? (character.bustCrop || { x: 55, y: 14, width: 210, height: 275.625 })
    : { x: 0, y: 0, width: SPRITE.width, height: SPRITE.height };
}

export function viewCrop(character, framing, source) {
  if (framing === 'bust' && source?.bust) return source.bust.manifest.crop || sourceRect(character, 'full');
  if (framing === 'full' && source?.manifest.crop) return source.manifest.crop;
  if (framing === 'bust' && source?.manifest.crop) {
    const full=source.manifest.crop, crop=sourceRect(character, 'bust');
    return {x:full.x+crop.x*full.width/320,y:full.y+crop.y*full.height/420,
      width:crop.width*full.width/320,height:crop.height*full.height/420};
  }
  return sourceRect(character, framing);
}

export function speakingFrame(state, elapsed, fps, still, talk, expressive) {
  // Authored attention frames have closed, open and rounded mouths. This is
  // audio-driven expression switching, not phoneme-level lip sync.
  if (expressive && talk > 0.04 && state !== 'sleep' && state !== 'error' && !still) {
    return 8 + (talk < 0.15 ? 3 : 1 + Math.floor(elapsed / 140) % 2);
  }
  return frameFor(state, elapsed, fps, still);
}

export class CharacterRenderer {
  constructor(canvas, image, character) {
    const native = dimensions(character);
    this.source = image.manifest ? image : null;
    if(this.source)this.pixels=this.source.initialPixels;
    if (!this.source && (image.naturalWidth !== character.columns * native.width || image.naturalHeight !== character.rows * native.height)) {
      throw new Error(`Invalid character atlas: ${character.id}`);
    }
    this.canvas = canvas;
    this.image = image;
    this.character = character;
    this.ctx = canvas.getContext('2d');
    this.frameCanvas = document.createElement('canvas');
    this.frameCanvas.width = SPRITE.width;
    this.frameCanvas.height = SPRITE.height;
    this.frameCtx = this.frameCanvas.getContext('2d', { willReadFrequently: true });
    this.rig = new CharacterRig();
    this.motion = new ConversationMotion(character.id,{orderedSpeech:!!character.orderedSpeech});
    this.torso = character.secondaryMotion ? new TorsoMotion(character.secondaryMotion) : null;
    if (this.torso) this.torsoCanvas=document.createElement('canvas');
    this.composite = document.createElement('canvas');
    this.compositeCtx = this.composite.getContext('2d');
    this.previousComposite = document.createElement('canvas');
    this.previousComposite.width = this.previousComposite.height = 1;
    this.transitionAt = -Infinity;
    this.state = 'idle';
    this.started = performance.now();
    this.frame = -1;
    this.selectFrame(0);
  }

  selectFrame(frame) {
    if (this.frame === frame) return;
    this.frame = frame;
    const { width, height } = SPRITE;
    this.frameCtx.clearRect(0, 0, width, height);
    const crop = sourceRect(this.character, this.framing);
    if (this.source) return; // Updated atomically after all layers are ready.
    const rect = atlasRect(frame, this.character, crop);
    this.frameCtx.imageSmoothingEnabled = true;
    this.frameCtx.imageSmoothingQuality = 'high';
    this.frameCtx.drawImage(this.image, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    this.pixels = this.frameCtx.getImageData(0, 0, width, height).data;
  }

  setFraming(framing) {
    this.torso?.reset();
    this.framing = framing === 'bust' ? 'bust' : 'full';
    const frame = this.frame;
    this.frame = -1;
    this.selectFrame(frame);
    this.compositeKey = null;
    this.transitionAt = -Infinity;
  }

  resize(scale) {
    this.scale = scale;
    const dpr = window.devicePixelRatio || 1;
    const width = (SPRITE.width + SPRITE.pad * 2) * scale;
    const height = (SPRITE.height + SPRITE.pad * 2) * scale;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  playClip(name) {
    if (reducedMotion.matches || !this.source?.manifest.variants[0].layers[0].tracks?.[name]) return;
    this.special = {name, started: performance.now()};
  }

  draw(p, context = {}) {
    const now = performance.now();
    const state = animationFor(context);
    if (state !== this.state) {
      this.state = state;
      this.started = now;
    }
    this.selectFrame(speakingFrame(state, now - this.started, this.character.fps, reducedMotion.matches, context.talk, this.character.expressive));
    const motion = this.motion.update(now, {...context, state, still: reducedMotion.matches || this.character.stillImage});
    const secondary = this.torso?.update(now, {...context,...motion,state,
      angle:motion.angle+(context.bodyAngle||0),still:reducedMotion.matches});
    if (this.special) {
      const frames=this.source?.manifest.variants[0].layers[0].tracks?.[this.special.name];
      const elapsed=now-this.special.started;
      if (!frames || reducedMotion.matches || state!=='idle' || context.reaction || context.lineTalking || context.talk>.04 || context.act || context.dance || context.clip==='walk' || !['stand','sit'].includes(context.stance) || elapsed>=frames.length*1000/(this.character.fps || 4)) this.special=null;
      else context={...context,special:{name:this.special.name,elapsed}};
    }
    if (this.source) this.prepareComposite(now, {...context, ...motion});
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    const scale = this.scale * (window.devicePixelRatio || 1);
    ctx.scale(scale, scale);
    ctx.translate(motion.danceX,motion.danceY);
    if (!this.source?.manifest.rigged && !this.character.stillImage) {
      const x=SPRITE.pad+SPRITE.feet.x,y=SPRITE.pad+SPRITE.feet.y;
      ctx.translate(x,y);ctx.rotate(motion.angle);ctx.scale(1,1+motion.breath);ctx.translate(-x,-y);
    }
    ctx.globalAlpha = clamp((p.alpha ?? 1) * (1 - (p.dissolve || 0)), 0, 1);
    ctx.translate(SPRITE.pad + SPRITE.width / 2, SPRITE.pad);
    ctx.scale(Math.max(0.01, 1 - (p.collapse || 0)), 1);
    // From the atlas, not frameCanvas: a bust crop resampled twice comes out blurry.
    const dedicatedBust=this.source?.bust && this.framing==='bust';
    const crop = viewCrop(this.character, this.framing, this.source), f = this.frame;
    if (this.source) {
      if (this.compositeReady && this.compositeView === (dedicatedBust ? 'bust' : 'full')) {
        const ratio=this.composite.width / SPRITE.width;
        const blend = poseBlend(now - this.transitionAt, reducedMotion.matches, this.character.poseBlendMs);
        const opacity = ctx.globalAlpha;
        if(this.torso) {
          this.drawSecondary(ctx,crop,blend,secondary,dedicatedBust);
        } else {
        ctx.globalAlpha = opacity * (1-blend);
        ctx.drawImage(this.composite,crop.x*ratio,crop.y*ratio,crop.width*ratio,crop.height*ratio,-160,0,320,420);
        if (blend && this.previousComposite.width > 1) {
          const previousRatio = this.previousComposite.width / SPRITE.width;
          ctx.globalAlpha = opacity * blend;
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(this.previousComposite,crop.x*previousRatio,crop.y*previousRatio,crop.width*previousRatio,crop.height*previousRatio,-160,0,320,420);
        }
        }
      }
    } else {
      const rect=atlasRect(f,this.character,crop);
      ctx.drawImage(this.image,rect.x,rect.y,rect.width,rect.height,-160,0,320,420);
    }
    ctx.restore();
  }

  drawSecondary(ctx,crop,blend,offsets,bust) {
    const image=this.torsoCanvas,w=this.composite.width,h=this.composite.height;
    if(image.width!==w || image.height!==h){image.width=w;image.height=h;}
    const stage=image.getContext('2d');stage.setTransform(1,0,0,1,0,0);
    stage.clearRect(0,0,w,h);stage.imageSmoothingEnabled=true;stage.imageSmoothingQuality='high';
    stage.globalCompositeOperation='source-over';stage.globalAlpha=1-blend;
    const ratio=w/320;
    stage.drawImage(this.composite,crop.x*ratio,crop.y*ratio,crop.width*ratio,crop.height*ratio,0,0,w,h);
    if(blend && this.previousComposite.width>1) {
      const previousRatio=this.previousComposite.width/320;
      stage.globalAlpha=blend;stage.globalCompositeOperation='lighter';
      stage.drawImage(this.previousComposite,crop.x*previousRatio,crop.y*previousRatio,crop.width*previousRatio,crop.height*previousRatio,0,0,w,h);
    }
    const profile=torsoRegions(this.character.secondaryMotion,bust?'bust':'full',this.compositeFrame);
    const regions=profile.map(r=>({x:(r.x-crop.x)*320/crop.width,y:(r.y-crop.y)*420/crop.height,
      rx:r.rx*320/crop.width,ry:r.ry*420/crop.height}));
    const gain=regions.length?Math.min(1.5,regions.reduce((n,r)=>n+r.rx,0)/regions.length/24):1;
    const boost=clamp(this.character.secondaryMotion.visualGain??1,1,2);
    const displacements=offsets.map(o=>({x:o.x*gain*boost,y:o.y*gain*boost}));
    ctx.save();ctx.translate(-160,0);drawTorsoMotion(ctx,image,regions,displacements);ctx.restore();
  }

  prepareComposite(now, context) {
    if(this.disposed || this.pendingComposite)return;
    const view=this.framing==='bust' && this.source.bust ? this.source.bust : this.source;
    const viewName=view===this.source?'full':'bust';
    const density=(this.scale||1)*(window.devicePixelRatio||1)*320/viewCrop(this.character,this.framing,this.source).width;
    const variant=chooseVariant(view.manifest.variants,density,gpuTextureLimit());
    if(!variant){this.fallback();return;}
    const state=this.state;
    const rigContext={...context,state,frame:this.frame,still:reducedMotion.matches};
    const elapsed=now-this.started;
    const selected=variant.layers.map(layer=>({layer,frame:layer.frames[trackFrame(layer,state,elapsed,this.character.fps,rigContext)]}));
    const key=JSON.stringify([variant.frameWidth,viewName,this.framing,selected.map(s=>s.layer.frames.indexOf(s.frame))]);
    if(!view.manifest.rigged && this.compositeKey===key)return;
    const pages=selected.map(s=>({...variant.pages[s.frame.page],url:new URL(variant.pages[s.frame.page].file,view.url).href}));
    this.pendingComposite=true;
    const source=this.source;
    atlasCache.group(pages,images=>{
      if(this.disposed || source!==this.source)return;
      const {frameWidth:w,frameHeight:h}=variant,ratio=w/320;
      if (!view.manifest.rigged && this.compositeReady && this.compositeView === viewName && this.compositeKey !== key && !reducedMotion.matches) {
        this.previousComposite.width = this.composite.width;
        this.previousComposite.height = this.composite.height;
        this.previousComposite.getContext('2d').drawImage(this.composite, 0, 0);
        this.transitionAt = performance.now();
      } else if (this.compositeView !== viewName || reducedMotion.matches) {
        this.transitionAt = -Infinity;
      }
      if(this.composite.width!==w || this.composite.height!==h){this.composite.width=w;this.composite.height=h;}
      const ctx=this.compositeCtx;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,w,h);
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      ctx.save();ctx.scale(ratio,ratio);ctx.beginPath();ctx.rect(0,0,320,420);ctx.clip();
      const motion=this.rig.update(now,rigContext),poses=new Map();
      for(const {layer,frame} of selected){
        const pose=this.rig.pose(layer,motion,rigContext),anchor=frame.anchor||[0,0];
        pose.x+=anchor[0];pose.y+=anchor[1];poses.set(layer.id,pose);
      }
      for(let i=0;i<selected.length;i++) {
        const {layer,frame}=selected[i];ctx.save();
        // Optional authored safe region keeps spring-driven cloth inside its
        // outer silhouette. It is not a collision solver for flattened art.
        if(layer.clip){ctx.beginPath();ctx.rect(...layer.clip);ctx.clip();}
        applyPose(ctx,layer,poses,variant.layers);
        ctx.drawImage(images[i],frame.x,frame.y,w,h,0,0,320,420);
        ctx.restore();
      }
      ctx.restore();
      this.compositeReady=true;this.compositeKey=key;this.compositeView=viewName;this.activeResolution=[w,h];
      this.compositeFrame=selected[0].layer.frames.indexOf(selected[0].frame);
      // Hit-testing alone is low resolution; the visible image never passes
      // through this mask canvas.
      const c=viewCrop(this.character,this.framing,source);
      this.frameCtx.clearRect(0,0,320,420);
      this.frameCtx.drawImage(this.composite,c.x*ratio,c.y*ratio,c.width*ratio,c.height*ratio,0,0,320,420);
      this.pixels=this.frameCtx.getImageData(0,0,320,420).data;
    }).catch(error=>{console.warn('[sprite] atlas load failed',error.message);this.fallback();})
      .finally(()=>{this.pendingComposite=false;});
  }

  async fallback() {
    if(this.fallingBack||this.disposed)return;
    this.fallingBack=true;
    try {
      const image=new Image();image.src=assetURL(this.character,this.character.atlas);await image.decode();
      if(this.disposed)return;
      const size=dimensions(this.character);
      if(image.naturalWidth!==this.character.columns*size.width||image.naturalHeight!==this.character.rows*size.height)throw new Error('Legacy fallback dimensions mismatch');
      this.source=null;this.image=image;const frame=this.frame;this.frame=-1;this.selectFrame(frame);
    }catch(error){console.error('[sprite] no usable fallback',error.message);}
  }

  async ready() {
    if(!this.source)return;
    this.prepareComposite(performance.now(),{});
    // Initial frame is needed for the actor's initial collision hull.
    await atlasCache.queue;
    if(this.fallingBack && !this.pixels)throw new Error('Could not initialize sprite');
  }

  dispose() {this.disposed=true;this.composite.width=this.composite.height=1;this.previousComposite.width=this.previousComposite.height=1;this.frameCanvas.width=this.frameCanvas.height=1;if(this.torsoCanvas)this.torsoCanvas.width=this.torsoCanvas.height=1;this.image=null;this.source=null;}
}

// Keep Capri's original shader and acting; copy its offscreen drawing into the shared canvas.
class CapriRenderer {
  constructor(canvas, image, character) {
    this.canvas = canvas;
    this.character = character;
    this.ctx = canvas.getContext('2d');
    this.source = document.createElement('canvas');
    this.legacy = new SpriteRenderer(this.source, image);
    this.legacy.resize(1);
    this.strips = new Map();
    this.loading = new Set();
    this.stripBytes = 0;
    this.strip = null;
    this.special = null;
    this.disposed = false;
    const mask = document.createElement('canvas');
    mask.width = SPRITE.width;
    mask.height = SPRITE.height;
    const ctx = mask.getContext('2d');
    const offset = SPRITE.feet.x - CAPRI.feet.x;
    ctx.drawImage(image, offset, 0);
    this.pixels = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let y = 0; y < CAPRI.height; y++) {
      for (let x = 0; x < CAPRI.width; x++) {
        if (CAPRI.armL(x, y) && CAPRI.mirror - x < CAPRI.width) {
          const to = (y * SPRITE.width + offset + CAPRI.mirror - x) * 4 + 3;
          this.pixels[to] = Math.max(this.pixels[to], this.pixels[(y * SPRITE.width + offset + x) * 4 + 3]);
        }
      }
    }
    this.basePixels = this.pixels;
    this.hitCanvas = document.createElement('canvas');
    this.hitCanvas.width = SPRITE.width;
    this.hitCanvas.height = SPRITE.height;
    this.hitCtx = this.hitCanvas.getContext('2d', { willReadFrequently: true });
    this.hitFrame = null;
  }

  resize(scale) { CharacterRenderer.prototype.resize.call(this, scale); }

  playClip(name) {
    if (!CAPRI_STRIPS[name] || reducedMotion.matches) return;
    this.special = { name, started: null };
    this.strip = null;
    this.getStrip(name);
  }

  getStrip(name) {
    if (this.strips.has(name)) {
      const strip = this.strips.get(name);
      this.strips.delete(name); this.strips.set(name, strip);
      return strip;
    }
    if (!this.loading.has(name)) {
      this.loading.add(name);
      loadCapriStrip(name).then(strip => {
        this.loading.delete(name);
        if (this.disposed) return;
        while (strip && this.stripBytes + strip.bytes > 32 * 1024 * 1024 && this.strips.size) {
          const oldest = this.strips.keys().next().value;
          this.stripBytes -= this.strips.get(oldest)?.bytes || 0;
          this.strips.delete(oldest);
        }
        this.strips.set(name, strip);
        this.stripBytes += strip?.bytes || 0;
      });
    }
    return null;
  }

  draw(p, context) {
    this.state = animationFor(context);
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = this.scale * (window.devicePixelRatio || 1);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (this.special && (context.mode === 'alert' || context.reaction || context.lineTalking || context.talk > 0.04 || (context.act && context.act !== 'talk') || ['fly', 'fall', 'held', 'down', 'peek'].includes(context.stance))) this.special = null;
    const special = this.special;
    const name = capriStripFor({ ...context, clip: special?.name || context.clip }, reducedMotion.matches || p.silAmount > 0 || p.collapse > 0 || p.dissolve > 0);
    const clip = name && this.getStrip(name);
    if (clip) {
      const now = performance.now(), spec = CAPRI_STRIPS[name];
      if (this.strip?.name !== name) this.strip = { name, start: now };
      if (special && name === special.name) {
        special.started ??= now;
        if (now - special.started >= spec.count * 1000 / spec.fps) { this.special = null; this.strip = null; return this.draw(p, context); }
      }
      let index = Math.floor((now - this.strip.start) * spec.fps / 1000) % spec.count;
      let shown = clip;
      if (name === 'perch' && index >= 9 && index < 13) {
        const lap = Math.floor((now - this.strip.start) * spec.fps / 1000 / spec.count);
        const blink = this.getStrip(lap % 5 === 4 ? 'perch_blink_glitch' : 'perch_blink');
        if (blink) { shown = blink; index -= 9; }
      }
      const height = SPRITE.height * spec.scale, width = height * clip.width / clip.height;
      const x = SPRITE.pad + SPRITE.feet.x - width / 2;
      const y = spec.anchor === 'seat' ? SPRITE.pad + SPRITE.hip - height * spec.seat : SPRITE.pad + SPRITE.feet.y - height;
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.globalAlpha = clamp(p.alpha ?? 1, 0, 1);
      ctx.translate(2 * (SPRITE.pad + SPRITE.feet.x), 0);
      ctx.scale(-1, 1);
      ctx.drawImage(shown.frames[index], x, y, width, height);
      const talking = context.lineTalking || context.talk > 0.04;
      const mouth = name === 'idle' && talking ? this.getStrip('mouth') : null;
      if (mouth) {
        const mouthFrame = capriMouthCell(context.talkLine, now - (context.talkStarted || now));
        ctx.drawImage(mouth.frames[mouthFrame], x, y, width, height);
      }
      ctx.restore();
      const hitFrame = `${name}:${shown === clip ? '' : 'blink'}:${index}`;
      if (this.hitFrame !== hitFrame) {
        this.hitCtx.clearRect(0, 0, SPRITE.width, SPRITE.height);
        this.hitCtx.drawImage(canvas, SPRITE.pad * scale, SPRITE.pad * scale, SPRITE.width * scale, SPRITE.height * scale, 0, 0, SPRITE.width, SPRITE.height);
        this.pixels = this.hitCtx.getImageData(0, 0, SPRITE.width, SPRITE.height).data;
        this.hitFrame = hitFrame;
      }
      return;
    }
    this.strip = null;
    this.pixels = this.basePixels;
    this.hitFrame = null;
    this.legacy.draw(p);
    talkStretch(ctx, this, context?.talk);
    ctx.drawImage(this.source, SPRITE.feet.x - CAPRI.feet.x, 0, CAPRI.width + CAPRI.pad * 2, CAPRI.height + CAPRI.pad * 2);
  }

  dispose() { this.disposed = true; this.strips.clear(); this.hitCanvas.width = this.hitCanvas.height = 1; this.legacy.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

export function createCharacterRenderer(canvas, image, character) {
  return character.renderer === 'capri' ? new CapriRenderer(canvas, image, character) : new CharacterRenderer(canvas, image, character);
}
