import { STANDARD_TRACKS } from './trackRegistry';
import type { TrackEntry } from './trackRegistry';

const find = (id: string): TrackEntry => {
  const t = STANDARD_TRACKS.find(t => t.id === id);
  if (!t) throw new Error(`Tutorial base track not found: ${id}`);
  return t;
};

export const TUTORIAL_TRACKS: TrackEntry[] = [
  {
    ...find('oval_small'),
    id:   'tutorial_1',
    name: 'Tutorial 1 — The Basics',
    coachMessages: [
      {
        turn:  0,
        title: 'Welcome to delta-v racing!',
        body:
          'Each turn you pick one of the 9 dots shown around your car.\n\n' +
          '● CENTER dot — keeps your current speed\n' +
          '● OUTER dots — accelerate in that direction\n' +
          '● INNER dots — brake and steer\n\n' +
          'Tap any green dot to make your first move.',
      },
      {
        turn:  2,
        title: 'Your velocity',
        body:
          'See the arrow on your car? That\'s your velocity — where you\'ll naturally go next at the center dot.\n\n' +
          'Your speed carries over every turn. You can\'t stop instantly, so plan ahead!\n\n' +
          'Red dots = crash. Avoid them.',
      },
      {
        turn:  6,
        title: 'Almost there!',
        body:
          'Cross the finish line to complete the lap.\n\n' +
          'Your score is the number of turns taken — fewer is better.\n\n' +
          'After finishing, try Tutorial 2 to learn cornering.',
      },
    ],
  },
  {
    ...find('short_track'),
    id:   'tutorial_2',
    name: 'Tutorial 2 — Taking Corners',
    coachMessages: [
      {
        turn:  0,
        title: 'Cornering practice',
        body:
          'Straights let you build speed — but corners require braking!\n\n' +
          'Watch your velocity arrow. If it points off-track, you must slow down BEFORE the corner, not at it.\n\n' +
          'It takes multiple turns to brake, so think ahead.',
      },
      {
        turn:  4,
        title: 'Corner ahead!',
        body:
          'A tight corner is coming up.\n\n' +
          'Start braking NOW — pick a dot CLOSER to you (not the center) to reduce speed.\n\n' +
          'Tip: count how many turns you\'ll need to slow down before committing to full speed.',
      },
      {
        turn:  9,
        title: 'Speed management',
        body:
          'The fastest laps are NOT about maximum speed everywhere.\n\n' +
          'The key is carrying the right speed into each section:\n' +
          '  • Brake early, before corners\n' +
          '  • Accelerate out once you\'re pointed straight\n\n' +
          'Finish the lap and then try Tutorial 3!',
      },
    ],
  },
  {
    ...find('canada'),
    id:   'tutorial_3',
    name: 'Tutorial 3 — Full Circuit',
    coachMessages: [
      {
        turn:  0,
        title: 'Full circuit — checkpoints!',
        body:
          'This track has CHECKPOINTS (blue gates). You must cross all checkpoints before the finish line activates.\n\n' +
          'Plan your path to hit checkpoints while maintaining good speed.\n\n' +
          'Watch for the finish line — it glows white once all checkpoints are done.',
      },
      {
        turn:  7,
        title: 'The racing line',
        body:
          'Pro tip: the fastest path through a corner is the racing line.\n\n' +
          '  • Approach wide\n' +
          '  • Apex tight at the inside\n' +
          '  • Accelerate out wide\n\n' +
          'This lets you carry more speed through without crashing.',
      },
      {
        turn: 14,
        title: 'Final stretch',
        body:
          'Almost done! Keep momentum through the last section.\n\n' +
          'After you finish, your score goes on the leaderboard. Race again to beat your personal best.\n\n' +
          'Head to the Community tab to race tracks built by other players!',
      },
    ],
  },
];
