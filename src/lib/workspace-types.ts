export type Crop = "Potato" | "Onion" | "Garlic" | "Ginger" | "Chili";

export type Zone = {
  id: string;
  name: string;
  crop: Crop;
  batchName: string;
  capacity: number;
};

export type Facility = {
  id: string;
  name: string;
  location: string;
  zones: Zone[];
};
