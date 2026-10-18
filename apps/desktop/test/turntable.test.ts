import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_TURN,
  coast,
  dockShift,
  mix,
  nearing,
  rgbOf,
  swell,
  turnSpeed,
  unwrap,
  type Spin,
} from '../src/renderer/turntable.js';

const TAU = Math.PI * 2;

// Runs `seconds` of frames at 60 fps.
function run(spin: Spin, seconds: number, target: number): Spin {
  for (let t = 0; t < seconds; t += 1 / 60) spin = coast(spin, 1 / 60, target);

  return spin;
}

describe('turnSpeed', () => {
  it('turns once every 16 beats at the record’s tempo', () => {
    expect(BEATS_PER_TURN).toBe(16);
    // 120 BPM is 2 beats a second, so 16 beats take 8 s.
    expect(TAU / turnSpeed(120)).toBeCloseTo(8);
    expect(TAU / turnSpeed(174)).toBeCloseTo((16 * 60) / 174);
  });

  it('turns an unmeasured record as if at 120 BPM', () => {
    expect(turnSpeed(undefined)).toBe(turnSpeed(120));
    expect(turnSpeed(0)).toBe(turnSpeed(120));
  });
});

describe('coast', () => {
  const still: Spin = { angle: 0, speed: 0, flung: false };

  it('spins up to the tempo’s speed on play, and winds down slower on pause', () => {
    const target = turnSpeed(120);
    const up = run(still, 0.6, target);
    const playing = run(still, 5, target);
    const down = run(playing, 0.6, 0);

    expect(playing.speed).toBeCloseTo(target, 3);
    // One time constant in, each has covered the same share of its own way.
    expect(up.speed / target).toBeCloseTo(1 - Math.exp(-1), 1);
    expect(down.speed / target).toBeGreaterThan(Math.exp(-1));
    expect(run(playing, 10, 0).speed).toBe(0);
  });

  it('moves the angle by the speed and keeps it within one turn', () => {
    const turning = run({ angle: 0, speed: 3, flung: false }, 20, 3);

    expect(turning.angle).toBeGreaterThanOrEqual(0);
    expect(turning.angle).toBeLessThan(TAU);
  });

  it('lets a fling coast back to tempo, then counts it settled', () => {
    const target = turnSpeed(120);
    const flung = { angle: 0, speed: 20, flung: true };
    const soon = coast(flung, 1 / 60, target);

    expect(soon.flung).toBe(true);
    expect(soon.speed).toBeGreaterThan(target);

    const later = run(flung, 15, target);

    expect(later.flung).toBe(false);
    expect(later.speed).toBeCloseTo(target, 2);
  });
});

describe('unwrap', () => {
  it('takes the short way round across ±π', () => {
    expect(unwrap(0.1)).toBeCloseTo(0.1);
    expect(unwrap(TAU - 0.1)).toBeCloseTo(-0.1);
    expect(unwrap(-TAU + 0.1)).toBeCloseTo(0.1);
  });
});

describe('swell', () => {
  it('peaks on each bar’s first beat and fades through the bar', () => {
    // 120 BPM: a beat is 0.5 s and a bar 2 s.
    expect(swell(0, 120)).toBe(1);
    expect(swell(4, 120)).toBeCloseTo(1);
    expect(swell(0.5, 120)).toBeLessThan(1);
    expect(swell(1.9, 120)).toBeLessThan(swell(0.5, 120));
  });

  it('stays flat with no tempo', () => {
    expect(swell(1, undefined)).toBe(0);
  });
});

describe('nearing', () => {
  it('rises over the last lead seconds of the record', () => {
    expect(nearing(100, 300, 40)).toBe(0);
    expect(nearing(280, 300, 40)).toBeCloseTo(0.5);
    expect(nearing(300, 300, 40)).toBe(1);
    expect(nearing(10, undefined, 40)).toBe(0);
  });
});

describe('dockShift', () => {
  it('puts the playing card’s centre at the dock’s centre', () => {
    expect(dockShift(0, 40, 340, 8)).toBe(-170);
    expect(dockShift(3, 40, 340, 8)).toBe(-(3 * 48 + 170));
  });
});

describe('rgbOf', () => {
  it('reads the colours palette.ts writes', () => {
    expect(rgbOf('hsl(0 100% 50%)')).toEqual([255, 0, 0]);
    expect(rgbOf('hsl(120 100% 50%)')).toEqual([0, 255, 0]);
    expect(rgbOf('hsl(240 50% 66%)')).toEqual([125, 125, 212]);
    expect(rgbOf('#fff')).toBeUndefined();
  });

  it('mixes part way between two colours', () => {
    expect(mix([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
    expect(mix([99.5, 200, 50], [100, 200, 50], 0.1)).toEqual([100, 200, 50]);
  });
});
