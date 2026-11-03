export type ProductSection = "grocery" | "snacks" | "household" | "beverage" | "dairy" | "stock";
export type PackageShape = "pouch" | "carton" | "bottle" | "tin" | "tub" | "bar" | "gable";
export interface ProductVisual {
  name: string;
  shape: PackageShape;
  color: string;
  width: number;
  height: number;
  depth: number;
  motif: "grain" | "leaf" | "fruit" | "milk" | "clean";
}
const item = (
  name: string,
  shape: PackageShape,
  color: string,
  width: number,
  height: number,
  depth: number,
  motif: ProductVisual["motif"],
): ProductVisual => ({ name, shape, color, width, height, depth, motif });
/** Visual catalog only: no prices or stock counts. Inventory adapters can resolve by name. */
export const PRODUCT_CATALOG: Record<ProductSection, ProductVisual[]> = {
  grocery: [
    item("Atta", "pouch", "#b73230", 0.24, 0.34, 0.12, "grain"),
    item("Rice", "pouch", "#338250", 0.22, 0.33, 0.13, "grain"),
    item("Toor Dal", "pouch", "#e7a32d", 0.2, 0.28, 0.12, "grain"),
    item("Oil", "bottle", "#f1b829", 0.15, 0.36, 0.15, "leaf"),
    item("Tea", "carton", "#237850", 0.2, 0.29, 0.13, "leaf"),
    item("Coffee", "tin", "#8c4834", 0.15, 0.26, 0.15, "grain"),
    item("Salt", "pouch", "#2d87b3", 0.2, 0.28, 0.1, "grain"),
    item("Spices", "carton", "#b9362d", 0.15, 0.23, 0.09, "leaf"),
  ],
  snacks: [
    item("Biscuits", "bar", "#eec84e", 0.29, 0.14, 0.1, "grain"),
    item("Noodles", "pouch", "#f2c823", 0.26, 0.22, 0.12, "grain"),
    item("Chips", "pouch", "#dc4831", 0.23, 0.33, 0.14, "leaf"),
    item("Crunch", "pouch", "#e9782b", 0.22, 0.32, 0.13, "leaf"),
    item("Cookies", "bar", "#2878b1", 0.24, 0.16, 0.11, "grain"),
    item("Namkeen", "pouch", "#349654", 0.22, 0.29, 0.12, "grain"),
  ],
  household: [
    item("Detergent", "pouch", "#2e8dbb", 0.23, 0.32, 0.12, "clean"),
    item("Dishwash", "bottle", "#3a9251", 0.15, 0.31, 0.14, "clean"),
    item("Shampoo", "bottle", "#e3ded3", 0.14, 0.33, 0.13, "leaf"),
    item("Toothpaste", "bar", "#c43b40", 0.27, 0.12, 0.08, "clean"),
    item("Soap", "bar", "#d6aabc", 0.2, 0.14, 0.09, "clean"),
    item("Handwash", "bottle", "#418456", 0.15, 0.29, 0.14, "clean"),
  ],
  beverage: [
    item("Mango", "carton", "#ebbe32", 0.15, 0.29, 0.13, "fruit"),
    item("Cola", "bottle", "#2f619d", 0.14, 0.36, 0.14, "fruit"),
    item("Lime", "bottle", "#358659", 0.14, 0.36, 0.14, "fruit"),
    item("Water", "bottle", "#68b9be", 0.14, 0.36, 0.14, "clean"),
    item("Juice", "carton", "#c75332", 0.18, 0.31, 0.15, "fruit"),
  ],
  dairy: [
    item("Milk", "pouch", "#d7eaf2", 0.22, 0.25, 0.13, "milk"),
    item("Milk Carton", "gable", "#dae9ef", 0.16, 0.32, 0.15, "milk"),
    item("Curd", "tub", "#e7eee4", 0.2, 0.19, 0.2, "milk"),
    item("Butter", "bar", "#f2ce65", 0.22, 0.15, 0.13, "milk"),
    item("Paneer", "pouch", "#77b5c6", 0.21, 0.26, 0.12, "milk"),
    item("Ghee", "tin", "#dfbd51", 0.18, 0.28, 0.18, "milk"),
  ],
  stock: [item("Supplies", "carton", "#bf945f", 0.35, 0.3, 0.32, "grain")],
};
export function productVisual(name: string): ProductVisual | undefined {
  return Object.values(PRODUCT_CATALOG)
    .flat()
    .find((p) => p.name.toLowerCase() === name.toLowerCase());
}
