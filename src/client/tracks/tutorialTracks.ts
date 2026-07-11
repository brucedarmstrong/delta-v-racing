import type { TrackEntry } from './trackRegistry';

// Turn numbers below were tuned against the actual solver output for each
// track (average/rookie skill), not guessed — see tools/tmp-solve-tutorials.ts.
export const TUTORIAL_TRACKS: TrackEntry[] = [
  {
    id:           'tutorial_1',
    name:         'Tutorial 1: First Steps',
    author:       'MaxDoor',
    startX:       88.57711097508047,
    startY:       429.5750717618806,
    startHeading: 0,
    pieces: [
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 61.230769230769226,  rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 181.23076923076923,  rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 301.2307692307692,   rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 421.2307692307692,   rotation: 0 },
      { type: 'straight', size: 100, walls: 'outer', x: 99.37023313556102, y: 533.6935398523483,   rotation: 90 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: -58.769230769230774, rotation: 0 },
    ],
    markers: [
      { kind: 'finish', shape: 'gate', x: 101.63137905333761, y: -99.06032045292196, rotation: 180 },
    ],
    coachMessages: [
      {
        turn:  0,
        title: 'Welcome to Delta-V Racing!',
        body:
          'Each turn you pick one of the 9 dots shown around your car.\n\n' +
          '● CENTER dot — keeps your current speed\n' +
          '● OUTER dots — accelerate in that direction\n' +
          '● INNER dots — brake and steer\n\n' +
          'Tap any green dot to make your first move.',
      },
      {
        turn:  3,
        title: 'Your velocity',
        body:
          'See the arrow on your car? That\'s your velocity — where you\'ll go next if you pick the center dot.\n\n' +
          'Your speed carries over every turn, so you can\'t stop instantly. Keep an eye on that arrow as you build up speed.\n\n' +
          'Red dots = crash. Avoid them.',
      },
      {
        turn:  7,
        title: 'Straight to the finish',
        body:
          'This track is a straight shot — perfect for getting a feel for acceleration with nothing to dodge.\n\n' +
          'Cross the finish line to complete the lap. Your score is the number of turns taken, so fewer is better.\n\n' +
          'When you\'re ready, try Tutorial 2 to learn cornering.',
      },
    ],
  },
  {
    id:           'tutorial_2',
    name:         'Tutorial 2: Corner Basics',
    author:       'MaxDoor',
    startX:       88.57711097508047,
    startY:       429.5750717618806,
    startHeading: 0,
    pieces: [
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 61.230769230769226,  rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 181.23076923076923,  rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 301.2307692307692,   rotation: 0 },
      { type: 'straight', size: 100, walls: 'both',  x: 101.015387901893,  y: 421.2307692307692,   rotation: 0 },
      { type: 'corner',   angle: 90, walls: 'both',  flip: true, x: 161.015387901893, y: 1.230769230769219, rotation: 270 },
      { type: 'straight', size: 100, walls: 'both',  x: 221.015387901893,  y: -58.76923076923079,  rotation: 90 },
      { type: 'straight', size: 100, walls: 'both',  x: 341.015387901893,  y: -58.7692307692308,   rotation: 90 },
      { type: 'straight', size: 100, walls: 'outer', x: 99.37023313556102, y: 533.6935398523483,   rotation: 90 },
    ],
    markers: [
      { kind: 'finish', shape: 'gate', x: 378.7896913047648, y: -61.13415804839735, rotation: 270 },
    ],
    coachMessages: [
      {
        turn:  0,
        title: 'Time for a corner',
        body:
          'You\'ve got the straights down — now let\'s add a turn.\n\n' +
          'Corners require braking. Watch your velocity arrow: if it\'s pointing off-track, you need to slow down BEFORE you get there, not once you arrive.\n\n' +
          'It takes several turns to shed speed, so start early.',
      },
      {
        turn:  4,
        title: 'Corner ahead!',
        body:
          'The corner is just ahead.\n\n' +
          'Start braking now — pick a dot CLOSER to your car (not the outer ring) to shed speed before you turn.\n\n' +
          'Tip: count how many turns you\'ll need to slow down, and start braking that many turns early.',
      },
      {
        turn:  9,
        title: 'Nailed it',
        body:
          'Once you\'re pointed straight again after the corner, you can get back on the accelerator.\n\n' +
          'The fastest laps aren\'t about going flat-out everywhere — it\'s about carrying the right speed into every section.\n\n' +
          'Finish the lap, then head to Tutorial 3 for checkpoints.',
      },
    ],
  },
  {
    id:           'tutorial_3',
    name:         'Tutorial 3: Checkpoints',
    author:       'MaxDoor',
    startX:       -312,
    startY:       -696,
    startHeading: 180,
    pieces: [
      { type: 'straight',   size: 100, walls: 'both', x: -297.3045004884521,   y: -664.1692588715875,  rotation: 0 },
      { type: 'big_corner', angle: 90, walls: 'both', flip: true,  x: -117.3045004884521,  y: -604.1692588715875,  rotation: 180 },
      { type: 'straight',   size: 100, walls: 'both', x: -57.30450048845209,   y: -424.16925887158754, rotation: 270 },
      { type: 'big_corner', angle: 90, walls: 'both', flip: false, x: 2.695499511547919,   y: -244.16925887158754, rotation: 90 },
      { type: 'straight',   size: 100, walls: 'both', x: 182.69549951154792,   y: -184.16925887158757, rotation: 0 },
    ],
    markers: [
      { kind: 'finish',     shape: 'gate',   x: 183.16226026152077,  y: -143.84179276106153, rotation: 180 },
      { kind: 'checkpoint', shape: 'gate',   x: -244.7581963274368,  y: -479.2264673976336,  rotation: 135 },
      { kind: 'checkpoint', shape: 'circle', x: 76.95179137175359,   y: -402.30334070291303,  rotation: 0 },
    ],
    coachMessages: [
      {
        turn:  0,
        title: 'Full circuit — checkpoints!',
        body:
          'This track has CHECKPOINTS (the gates and circles along the way). You must cross every checkpoint before the finish line will activate.\n\n' +
          'The two corners here are wide, sweeping turns — you can carry more speed through them than the tight one from Tutorial 2.\n\n' +
          'Plan a path that hits every checkpoint without losing too much speed.',
      },
      {
        turn:  6,
        title: 'The racing line',
        body:
          'Pro tip for wide corners like these: the fastest path is the racing line.\n\n' +
          '  • Approach wide\n' +
          '  • Apex tight at the inside\n' +
          '  • Accelerate out wide\n\n' +
          'This lets you carry more speed through without crashing.',
      },
      {
        turn: 12,
        title: 'Final stretch',
        body:
          'Almost there! Make sure you\'ve crossed both checkpoints — the finish line glows white once you have.\n\n' +
          'That\'s the whole tutorial series. Your times go on the leaderboard, so race again to beat your best.\n\n' +
          'Head to the Community tab to try tracks built by other players!',
      },
    ],
  },
];
