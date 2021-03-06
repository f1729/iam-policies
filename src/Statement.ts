const reDelimiters = /\${([^}])*}/g;
const trim = / +(?= )|^\s+|\s+$/g;

type StatementEffect = 'allow' | 'deny';
type StatementPattern = string;

interface Condition {
  [key: string]: any;
}

interface StatementConditions {
  [key: string]: Condition;
}

interface Balance {
  start: number;
  end: number;
  pre: string;
  body: string;
  post: string;
}

type StatementConfig = {
  effect?: StatementEffect;
  resource: StatementPattern[] | StatementPattern;
  action: StatementPattern[] | StatementPattern;
  condition?: StatementConditions;
};

type Resolver = (data: any, expected: any) => boolean;

interface ConditionResolver {
  [key: string]: Resolver;
}

export function getValueFromPath(data: any, path: string): any | never {
  const value = path.split('.').reduce((key, nextChild) => {
    return data[key] ? data[key][nextChild] : undefined;
  });

  if (value instanceof Array) return `{${value}}`;

  return value;
}

const specialTrim = (str: string): string => str.replace(trim, '');

export function applyContext(str: string, context?: object): string {
  if (!context) return str;

  return specialTrim(
    str.replace(reDelimiters, match => {
      const path = match.substr(2, match.length - 3);

      return match ? String(getValueFromPath(context, path)) : '';
    })
  );
}

function range(a: string, b: string, str: string): number[] {
  const left = str.indexOf(a);
  const right = str.indexOf(b, left + 1);

  if (left >= 0 && right > 0) {
    return [left, right];
  }

  return [-1, -1];
}

function balanced(a: string, b: string, str: string): Balance {
  const r = range(a, b, str);

  return {
    start: r[0],
    end: r[1],
    pre: r[0] >= 0 ? str.slice(0, r[0]) : '',
    body: r[0] >= 0 ? str.slice(r[0] + a.length, r[1]) : '',
    post: r[0] >= 0 ? str.slice(r[1] + b.length) : '',
  };
}

export class Matcher {
  private readonly pattern: string;
  private readonly set: (string | RegExp)[];
  private readonly empty: boolean;
  private hasSpecialCharacter: boolean;

  constructor(pattern: string) {
    this.set = [];
    this.pattern = pattern.trim();
    this.empty = !this.pattern ? true : false;
    this.hasSpecialCharacter = false;

    const set = this.braceExpand();
    this.set = set.map(val => this.parse(val));
    this.set = this.set.filter(s => {
      return Boolean(s);
    });
  }

  braceExpand(): string[] {
    let pattern = this.pattern;
    if (!pattern.match(/{.*}/)) {
      return [pattern];
    }
    // I don't know why Bash 4.3 does this, but it does.
    // Anything starting with {} will have the first two bytes preserved
    // but only at the top level, so {},a}b will not expand to anything,
    // but a{},b}c will be expanded to [a}c,abc].
    // One could argue that this is a bug in Bash, but since the goal of
    // this module is to match Bash's rules, we escape a leading {}
    if (pattern.substr(0, 2) === '{}') {
      pattern = '\\{\\}' + pattern.substr(2);
    }

    return this.expand(pattern, true);
  }

  parse(pattern: string): string | RegExp {
    if (pattern.length > 1024 * 64) {
      throw new TypeError('pattern is too long');
    }
    let regExp,
      re = '';
    if (pattern === '') return '';

    for (
      let i = 0, len = pattern.length, c;
      i < len && (c = pattern.charAt(i));
      i++
    ) {
      if (c === '*') {
        this.hasSpecialCharacter = true;
        re += '[^/]*?';
      } else {
        re += c;
      }
    }

    // if the re is not '' at this point, then we need to make sure
    // it doesn't match against an empty path part.
    // Otherwise a/* will match a/, which it should not.
    if (re !== '' && this.hasSpecialCharacter) {
      re = '(?=.)' + re;
    }

    // skip the regexp for non-* patterns
    // unescape anything in it, though, so that it'll be
    // an exact match.
    if (!this.hasSpecialCharacter) {
      return pattern.replace(/\\(.)/g, '$1');
    }

    try {
      regExp = new RegExp('^' + re + '$');
    } catch (error) {
      // If it was an invalid regular expression, then it can't match
      // anything.
      return new RegExp('$.');
    }

    return regExp;
  }

  expand(str: string, isTop?: boolean): string[] {
    const expansions = [] as string[];
    const balance = balanced('{', '}', str);
    if (balance.start < 0 || /\$$/.test(balance.pre)) return [str];
    let parts;

    if (!balance.body) parts = [''];
    else parts = balance.body.split(',');

    // no need to expand pre, since it is guaranteed to be free of brace-sets
    const pre = balance.pre;
    const postParts = balance.post.length
      ? this.expand(balance.post, false)
      : [''];

    parts.forEach(part => {
      postParts.forEach(postPart => {
        const expansion = pre + part + postPart;
        if (!isTop || expansion) expansions.push(expansion);
      });
    });

    return expansions;
  }

  match(str: string): boolean {
    if (this.empty) return str === '';

    const set = this.set;

    return set.some(pattern => this.matchOne(str, pattern));
  }

  matchOne(str: string, pattern: string | RegExp): boolean {
    if (!pattern) return false;

    if (typeof pattern === 'string') {
      return str === pattern;
    }

    return Boolean(str.match(pattern));
  }
}

export class Statement {
  effect: StatementEffect;
  private resource: StatementPattern[];
  private action: StatementPattern[];
  private readonly condition?: StatementConditions;

  constructor({
    effect = 'allow',
    resource,
    action,
    condition,
  }: StatementConfig) {
    this.effect = effect;
    this.resource = typeof resource === 'string' ? [resource] : resource;
    this.action = typeof action === 'string' ? [action] : action;
    this.condition = condition;
  }

  matches(
    action: string,
    resource: string,
    context?: object,
    conditionResolvers?: ConditionResolver
  ): boolean {
    return (
      this.action.some(a =>
        new Matcher(applyContext(a, context)).match(action)
      ) &&
      this.resource.some(r =>
        new Matcher(applyContext(r, context)).match(resource)
      ) &&
      (conditionResolvers && this.condition && context
        ? Object.keys(this.condition).every(condition =>
            Object.keys(
              this.condition ? this.condition[condition] : {}
            ).every(path =>
              conditionResolvers[condition](
                getValueFromPath(context, path),
                this.condition ? this.condition[condition][path] : ''
              )
            )
          )
        : true)
    );
  }
}

export { StatementConfig, ConditionResolver };
