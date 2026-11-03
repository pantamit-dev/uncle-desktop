const limit=(n,a,b)=>Math.max(a,Math.min(b,Number.isFinite(n)?n:0));
export function springSettings(input={}) {
  return {mass:limit(input.mass??1,.1,10),stiffness:limit(input.stiffness??80,1,300),
    damping:limit(input.damping??18,1,80),max:limit(input.max??2,0,8),
    drive:limit(input.drive??.002,0,.02),gravity:limit(input.gravity??0,-.02,.02)};
}
export class Spring {
  constructor(settings) {this.settings=springSettings(settings);this.x=0;this.v=0;}
  reset() {this.x=0;this.v=0;}
  step(dt,force=0) {
    const s=this.settings;dt=limit(dt,0,.05);force=limit(force,-100,100);
    const steps=Math.max(1,Math.ceil(dt/(1/240))),h=dt/steps;
    for(let i=0;i<steps;i++) {
      this.v+=((force-s.stiffness*this.x-s.damping*this.v)/s.mass)*h;
      this.x+=this.v*h;
      if(Math.abs(this.x)>s.max){this.x=limit(this.x,-s.max,s.max);this.v=0;}
    }
    return this.x;
  }
}

export function trackFrame(layer, state, elapsed, fps=4, context={}) {
  const still=context.still;
  let key=state;
  if(layer.role==='composite' && !still && state==='idle' && !context.reaction &&
    !context.lineTalking && !(context.talk>.04)) {
    const action=context.stance==='held' ? 'held' : !context.act ?
      (context.clip==='walk' && context.stance==='stand' ? 'walk' :
        context.dance ? 'dance' : context.stance==='sit' ? 'sit' : null) : null;
    const sequence=layer.tracks?.[action];
    if(sequence?.length)return sequence[Math.floor(elapsed*fps/1000)%sequence.length];
  }
  if(layer.role==='composite' && !still && (state==='idle'||state==='thinking') &&
    Number.isInteger(context.speechFrame) && layer.tracks?.speechMotion?.length) {
    const sequence=layer.tracks.speechMotion;
    return sequence[Math.max(0,Math.min(sequence.length-1,context.speechFrame))];
  }
  if(layer.role==='composite' && !still && (state==='idle' || state==='thinking') && context.speechPose && layer.tracks?.[context.speechPose]?.length) {
    return layer.tracks[context.speechPose][0];
  }
  if(layer.continuousTracks && !still && Number.isInteger(context.ambientFrame) && layer.tracks?.[`${state}Motion`]) {
    const frames=layer.tracks[`${state}Motion`];return frames[Math.max(0,Math.min(frames.length-1,context.ambientFrame))];
  }
  if(layer.role==='composite' && !layer.continuousTracks && !still && state==='idle' && context.blink && layer.tracks?.blink?.length) {
    const blink=layer.tracks.blink;return blink[Math.min(1,blink.length-1)];
  }
  if(layer.role==='composite' && !layer.continuousTracks && !still && context.directed && (state==='idle' || state==='thinking')) {
    if(context.speechPose==='talkPrepare' || context.speechPose==='talkRest') return layer.tracks?.idle?.[0] ?? 0;
    if(context.speechPose && layer.tracks?.talk?.length) {
      const talk=layer.tracks.talk;return talk[(context.gestureVariant || 0)%talk.length];
    }
    if(state==='idle')return layer.tracks?.idle?.[0] ?? 0;
  }
  if(layer.role==='mouth') key=still?'closed':context.viseme || (context.talk>.35?'open':context.talk>.04?'round':'closed');
  if(layer.role==='eyes') key=state==='sleep'?'closed':(!still && elapsed%4700>4500?'blink':'open');
  if(layer.role==='composite' && context.talk>.04 && !still && (state==='idle' || state==='thinking')) {
    if(layer.tracks?.talk?.length){const talk=layer.tracks.talk;return talk[Math.floor(elapsed/180)%talk.length];}
    return Math.min(context.frame??0,layer.frames.length-1);
  }
  if(layer.role==='pupil') key='idle';
  if(layer.role==='leg') key=context.stance==='sit'?'sit':context.moving?'walk':'idle';
  const sequence=layer.tracks?.[key] || layer.tracks?.[state] || layer.tracks?.idle;
  if(sequence) return sequence[still?0:Math.floor(elapsed*fps/1000)%sequence.length];
  return layer.frames.length===1?0:Math.min(context.frame??0,layer.frames.length-1);
}

export class CharacterRig {
  constructor(){this.springs=new Map();this.last=null;this.velocity={x:0,y:0};this.weight=0;this.previousState='idle';this.elapsed=0;}
  update(now,context={}) {
    const dt=this.last?limit((now-this.last.time)/1000,0,.05):0;
    const pos=context.position||{x:0,y:0};
    const dx=this.last?pos.x-this.last.x:0,dy=this.last?pos.y-this.last.y:0;
    const teleport=Math.hypot(dx,dy)>120 || (this.last && now-this.last.time>250);
    let velocity={x:dt?limit(dx/dt,-800,800):0,y:dt?limit(dy/dt,-800,800):0};
    if(teleport||context.still){velocity={x:0,y:0};for(const spring of this.springs.values())spring.reset();}
    const ax=teleport||!dt?0:limit((velocity.x-this.velocity.x)/dt,-3000,3000);
    const ay=teleport||!dt?0:limit((velocity.y-this.velocity.y)/dt,-3000,3000);
    this.velocity=velocity;this.last={time:now,...pos};this.elapsed+=dt;
    if(context.state!==this.previousState){this.weight=context.state==='error'?-1:1;this.previousState=context.state;}
    this.weight*=Math.exp(-dt*5);
    return {dt,ax,ay,velocity,teleport,time:this.elapsed};
  }
  pose(layer, motion, context={}) {
    let x=0,y=0,angle=0;
    const role=layer.role,phase=motion.time*5+(layer.side==='right'?Math.PI:0);
    if(!context.still) {
      if(role==='leg') {
        const moving=context.moving || Math.abs(motion.velocity.x)>20;
        angle=moving?Math.sin(phase)*.06:Math.sin(motion.time*.8)*.006;
        const pivot=layer.pivot||[160,270],foot=layer.foot||[pivot[0],418];
        const lift=context.stance==='sit'?8+Math.sin(motion.time)*1.5:moving?Math.max(0,Math.sin(phase))*5:0;
        // Compensate rotation around the hip so planted feet cannot sink below
        // the ground plane. No root displacement accumulates during walking.
        y=foot[1]-lift-(pivot[1]+Math.sin(angle)*(foot[0]-pivot[0])+Math.cos(angle)*(foot[1]-pivot[1]));
      }
      if(role==='torso'||role==='head'){angle=Math.sin(motion.time*1.8)*.003+this.weight*.006;}
      if(role==='pupil'){x=limit(context.gaze?.x||0,-1,1)*1.5;y=limit(context.gaze?.y||0,-1,1);}
      if(role==='brow'){y=context.state==='error'?-1:context.state==='success'?-.5:0;}
      if(layer.physics) {
        if(!this.springs.has(layer.id))this.springs.set(layer.id,new Spring(layer.physics));
        const spring=this.springs.get(layer.id),s=spring.settings;
        const force=-motion.ax*s.drive-motion.ay*s.drive*.25+(context.gravity?.y??980)*s.gravity+Math.sin(motion.time*1.8)*.25;
        x+=spring.step(motion.dt,force);
        angle+=x*.006;
      }
    }
    const max=limit(layer.maxTranslation??6,0,12);
    return {x:limit(x,-max,max),y:limit(y,-max,max),angle:limit(angle,-.12,.12)};
  }
}

// Layers are authored on the same logical registration plane. Apply each
// ancestor's transform so facial features follow the head, which follows torso.
export function applyPose(ctx,layer,poses,layers) {
  if(layer.parent)applyPose(ctx,layers.find(l=>l.id===layer.parent),poses,layers);
  const pose=poses.get(layer.id),[x,y]=layer.pivot||[160,210];
  ctx.translate(pose.x+x,pose.y+y);ctx.rotate(pose.angle);ctx.translate(-x,-y);
}
