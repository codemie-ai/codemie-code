const TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>.*?<\/\1>/s;
const SELF_CLOSING_PATTERN = /<[a-zA-Z][a-zA-Z0-9_-]*\/>/;
const PLACEHOLDER_PREFIX = '\x00TAG\x00';

export class TagProtector {
  private protectedTags: Map<string, string> = new Map();
  private counter: number = 0;

  protect(content: string): string {
    this.protectedTags = new Map();
    this.counter = 0;

    const tagRegex = new RegExp(TAG_PATTERN.source, TAG_PATTERN.flags + 'g');
    const selfClosingRegex = new RegExp(SELF_CLOSING_PATTERN.source, SELF_CLOSING_PATTERN.flags + 'g');

    let result = content.replace(tagRegex, (match) => {
      const key = `${PLACEHOLDER_PREFIX}${this.counter}\x00`;
      this.counter++;
      this.protectedTags.set(key, match);
      return key;
    });

    result = result.replace(selfClosingRegex, (match) => {
      const key = `${PLACEHOLDER_PREFIX}${this.counter}\x00`;
      this.counter++;
      this.protectedTags.set(key, match);
      return key;
    });

    return result;
  }

  restore(content: string): string {
    let result = content;
    for (const [key, value] of this.protectedTags) {
      result = result.split(key).join(value);
    }
    return result;
  }

  hasProtected(): boolean {
    return this.protectedTags.size > 0;
  }
}
