export interface WidgetOptions {
  readonly id: string;
  readonly label?: string;
}

export class Widget {
  resize(width: number, height: number): void {}
}

export function createWidget(
  name: string,
  options?: WidgetOptions,
): Widget {
  return new Widget();
}
