/**
 * PUBLIC_DEPLOYMENT spellings shared by the lock/reassert tests: every value config's boolean parser
 * accepts, in odd case and with surrounding whitespace, plus unset and blank (which mean off).
 */
export const PUBLIC_ON: string[] = ['1', 'true', 'TRUE', 'True', 't', 'T', 'yes', 'Yes', 'y', 'Y', 'on', 'ON', 'true ', ' on', '\ty\n'];
export const PUBLIC_OFF: Array<string | undefined> = [undefined, '', '  ', '0', 'false', 'False', 'f', 'no', 'n', 'off', 'OFF', 'false ', ' no '];
