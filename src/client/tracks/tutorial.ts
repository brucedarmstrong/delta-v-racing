import { convertGmsTrack, type GmsTrack } from '../track/convertGmsTrack';
import tutorialJson from './gms/Tutorial.json';

export const TUTORIAL = convertGmsTrack(tutorialJson as unknown as GmsTrack);
