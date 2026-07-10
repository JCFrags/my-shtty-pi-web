import Reconciler from "react-reconciler";
import { DefaultEventPriority } from "react-reconciler/constants";

import { createNativeEngine, NativeEngine } from "./native";
import { parseColor, serializeStyle, Style } from "./styles";

export const CONTAINER_ID = 0;

export interface ClickEvent {
  x: number;
  y: number;
}

export interface ScrollEvent {
  offset: number;
  max: number;
}

export interface BoxProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  onScroll?: (event: ScrollEvent) => void;
  contentHeight?: number;
  children?: React.ReactNode;
}

export interface TextProps {
  style?: Style;
  id?: string;
  onClick?: (event: ClickEvent) => void;
  children?: React.ReactNode;
}

export interface InputProps {
  style?: Style;
  id?: string;
  defaultValue?: string;
  value?: string;
  caretColor?: Style["color"];
  selectionColor?: Style["color"];
  autoFocus?: boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
}

type AnyProps = BoxProps & TextProps & InputProps;

export interface Instance {
  id: number;
  type: string;
  props: AnyProps;
  children: Instance[];
  mounted: boolean;
  hidden: boolean;
}

interface Container {
  id: typeof CONTAINER_ID;
}

type Op = Record<string, unknown>;

class Bridge {
  engine: NativeEngine = createNativeEngine();
  ops: Op[] = [];
  propsById = new Map<number, AnyProps>();
  private nextId = 1;

  allocId(): number {
    return this.nextId++;
  }

  push(op: Op) {
    this.ops.push(op);
  }

  flush() {
    if (this.ops.length === 0) return;
    const batch = this.ops;
    this.ops = [];
    this.engine.applyOps(JSON.stringify(batch));
  }
}

let bridge: Bridge | null = null;

export function getBridge(): Bridge {
  if (!bridge) bridge = new Bridge();
  return bridge;
}

function textOf(children: React.ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(textOf).join("");
  throw new Error("<Text> children must be strings or numbers");
}

function serializeProps(
  type: string,
  props: AnyProps,
  hidden: boolean,
  prevProps?: AnyProps
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    style: serializeStyle(props.style ?? {}),
    key: props.id,
    clickable: !!props.onClick,
    hidden,
    contentHeight: props.contentHeight,
    scrollEvents: !!props.onScroll,
  };
  if (type === "text") {
    base.text = textOf(props.children);
  } else if (type === "input") {
    const valueChanged = !prevProps || props.value !== prevProps.value;
    base.input = {
      initial: props.defaultValue ?? props.value ?? "",
      value: valueChanged ? props.value : undefined,
      caretColor: parseColor(props.caretColor),
      selectionColor: parseColor(props.selectionColor),
      autoFocus: !!props.autoFocus,
      submit: !!props.onSubmit,
    };
  }
  return base;
}

function materialize(b: Bridge, instance: Instance) {
  if (instance.mounted) return;
  instance.mounted = true;
  b.push({
    op: "create",
    id: instance.id,
    props: serializeProps(instance.type, instance.props, instance.hidden),
  });
  for (const child of instance.children) {
    materialize(b, child);
    b.push({ op: "insertBefore", parent: instance.id, child: child.id, before: null });
  }
}

function insert(parent: number, child: Instance, before: Instance | null) {
  const b = getBridge();
  materialize(b, child);
  b.push({ op: "insertBefore", parent, child: child.id, before: before?.id ?? null });
}

function remove(parent: number, child: Instance) {
  void parent;
  getBridge().push({ op: "remove", id: child.id });
}

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1 as const,

  createInstance(type: string, props: AnyProps): Instance {
    const b = getBridge();
    const instance: Instance = {
      id: b.allocId(),
      type,
      props,
      children: [],
      mounted: false,
      hidden: false,
    };
    b.propsById.set(instance.id, props);
    return instance;
  },

  createTextInstance(): never {
    throw new Error("Raw text must be wrapped in <Text>");
  },

  shouldSetTextContent(type: string): boolean {
    return type === "text";
  },

  appendInitialChild(parent: Instance, child: Instance) {
    parent.children.push(child);
  },

  finalizeInitialChildren(): boolean {
    return false;
  },

  prepareUpdate(
    _instance: Instance,
    _type: string,
    _oldProps: AnyProps,
    newProps: AnyProps
  ): AnyProps {
    return newProps;
  },

  commitUpdate(
    instance: Instance,
    newProps: AnyProps,
    _type: string,
    oldProps: AnyProps
  ) {
    const b = getBridge();
    const prevProps = instance.props;
    instance.props = newProps;
    b.propsById.set(instance.id, newProps);
    b.push({
      op: "update",
      id: instance.id,
      props: serializeProps(instance.type, newProps, instance.hidden, oldProps ?? prevProps),
    });
  },

  appendChild(parent: Instance, child: Instance) {
    insert(parent.id, child, null);
  },

  appendChildToContainer(_container: Container, child: Instance) {
    insert(CONTAINER_ID, child, null);
  },

  insertBefore(parent: Instance, child: Instance, before: Instance) {
    insert(parent.id, child, before);
  },

  insertInContainerBefore(_container: Container, child: Instance, before: Instance) {
    insert(CONTAINER_ID, child, before);
  },

  removeChild(parent: Instance, child: Instance) {
    remove(parent.id, child);
  },

  removeChildFromContainer(_container: Container, child: Instance) {
    remove(CONTAINER_ID, child);
  },

  clearContainer() {
    getBridge().push({ op: "clear", id: CONTAINER_ID });
  },

  detachDeletedInstance(instance: Instance) {
    const b = getBridge();
    b.propsById.delete(instance.id);
    b.push({ op: "forget", id: instance.id });
  },

  hideInstance(instance: Instance) {
    instance.hidden = true;
    getBridge().push({
      op: "update",
      id: instance.id,
      props: serializeProps(instance.type, instance.props, true, instance.props),
    });
  },

  unhideInstance(instance: Instance, props: AnyProps) {
    const prevProps = instance.props;
    instance.hidden = false;
    instance.props = props;
    getBridge().push({
      op: "update",
      id: instance.id,
      props: serializeProps(instance.type, props, false, prevProps),
    });
  },

  hideTextInstance() {},
  unhideTextInstance() {},
  commitTextUpdate() {},
  resetTextContent() {},
  commitMount() {},

  getRootHostContext(): null {
    return null;
  },

  getChildHostContext(parentContext: null): null {
    return parentContext;
  },

  getPublicInstance(instance: Instance) {
    return {
      id: instance.id,
      focus: () => {
        const b = getBridge();
        b.push({ op: "focus", id: instance.id });
        b.flush();
      },
      blur: () => {
        const b = getBridge();
        b.push({ op: "focus", id: null });
        b.flush();
      },
      scrollTo: (offset: number, smooth = false) => {
        const b = getBridge();
        b.push({ op: "scrollTo", id: instance.id, offset, smooth });
        b.flush();
      },
    };
  },

  prepareForCommit(): null {
    return null;
  },

  resetAfterCommit() {
    getBridge().flush();
  },

  preparePortalMount() {},

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,

  getCurrentEventPriority(): number {
    return DefaultEventPriority;
  },

  getInstanceFromNode(): null {
    return null;
  },

  getInstanceFromScope(): null {
    return null;
  },

  prepareScopeUpdate() {},
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reconciler = Reconciler(hostConfig as any);
