declare module "idiomorph" {
  export interface IdiomorphCallbacks {
    beforeNodeMorphed?: (
      oldNode: Node,
      newNode: Node
    ) => boolean | void;
  }

  export interface IdiomorphOptions {
    morphStyle?: "innerHTML" | "outerHTML";
    callbacks?: IdiomorphCallbacks;
  }

  export const Idiomorph: {
    morph(
      element: Element,
      content: string | Node,
      options?: IdiomorphOptions
    ): void;
  };
}
