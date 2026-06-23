import { convertGmsTrack, type GmsTrack } from '../track/convertGmsTrack';
import ovalSmallJson from './gms/Oval_Small.json';

export const OVAL_SMALL = convertGmsTrack(ovalSmallJson as unknown as GmsTrack);
