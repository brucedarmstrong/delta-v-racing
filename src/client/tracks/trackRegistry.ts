import type { PlacedPiece } from '../track/TrackLayout';
import type { TrackMarker } from '../track/convertGmsTrack';
import { convertGmsTrack, convertGmsMarkers, type GmsTrack } from '../track/convertGmsTrack';

import ovalSmallJson    from './gms/Oval_Small.json';
import shortTrackJson   from './gms/shortTrack.json';
import track4Json       from './gms/track4.json';
import canadaJson       from './gms/Canada.json';
import nurburgringJson  from './gms/Nurburgring.json';
import tutorialJson     from './gms/Tutorial.json';
import track3Json       from './gms/track3.json';
import json532          from './gms/532.json';
import acey1Json        from './gms/acey1.json';
import acey2Json        from './gms/acey2.json';
import crissCrossJson   from './gms/criss_cross.json';
import rustyspringsJson from './gms/rusty_springs.json';
import spiralJson       from './gms/spiral.json';
import bigoneJson       from './gms/bigone.json';

export type TrackEntry = {
  id:      string;
  name:    string;
  author:  string;
  startX:  number;
  startY:  number;
  pieces:  PlacedPiece[];
  markers: TrackMarker[];
};

function fromGms(
  json:   unknown,
  id:     string,
  name:   string,
  author: string,
  startX: number,
  startY: number,
): TrackEntry {
  const g = json as unknown as GmsTrack;
  return { id, name, author, startX, startY, pieces: convertGmsTrack(g), markers: convertGmsMarkers(g) };
}

export const STANDARD_TRACKS: TrackEntry[] = [
  fromGms(ovalSmallJson,    'oval_small',    'Oval Small',    'Boomsmith', 1080, 504),
  fromGms(shortTrackJson,   'short_track',   'Short Track',   'Boomsmith',  432, 216),
  fromGms(track4Json,       'track4',        'Track 4',       'Boomsmith',  216, 672),
  fromGms(canadaJson,       'canada',        'Canada',        'Boomsmith', 1440, 432),
  fromGms(nurburgringJson,  'nurburgring',   'Nurburgring',   'Boomsmith', 1656, 576),
  fromGms(json532,          '532',           '532',           'Boomsmith', 1176, 744),
  fromGms(acey1Json,        'acey1',         'ACEY 1',        'Boomsmith',  144, 312),
  fromGms(acey2Json,        'acey2',         'ACEY 2',        'Boomsmith',  864, 408),
  fromGms(crissCrossJson,   'criss_cross',   'Criss Cross',   'Boomsmith', 1296, 504),
  fromGms(rustyspringsJson, 'rusty_springs', 'Rusty Springs', 'Boomsmith',  696, 120),
  fromGms(spiralJson,       'spiral',        'Spiral',        'Boomsmith', 1008,  96),
  fromGms(bigoneJson,       'bigone',        'Big One',       'Boomsmith',  240, 240),
  fromGms(tutorialJson,     'tutorial',      'Tutorial',      'Player',     384, 312),
  fromGms(track3Json,       'track3',        'Track 3',       'Player',     408, 168),
];

export const TRACK_REGISTRY = new Map<string, TrackEntry>(
  STANDARD_TRACKS.map(t => [t.id, t]),
);
