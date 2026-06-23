import { convertGmsTrack, type GmsTrack } from '../track/convertGmsTrack';
import shortTrackJson from './gms/shortTrack.json';

export const SHORT_TRACK = convertGmsTrack(shortTrackJson as unknown as GmsTrack);
