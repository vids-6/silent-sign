from pathlib import Path

# Project root = parent of training/
PROJECT_ROOT = Path(__file__).resolve().parent.parent

DATASET_DIR = PROJECT_ROOT / "ISL_Dataset"

IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".webp"
}


def main():

    print()
    print("=" * 60)
    print("           ISL DATASET INSPECTOR")
    print("=" * 60)

    print(f"\nProject root:")
    print(PROJECT_ROOT)

    print(f"\nDataset:")
    print(DATASET_DIR)

    if not DATASET_DIR.exists():
        print("\nERROR: ISL_Dataset does not exist.")
        return

    class_dirs = sorted(
        [
            folder
            for folder in DATASET_DIR.iterdir()
            if folder.is_dir()
        ],
        key=lambda x: x.name.upper()
    )

    print(f"\nClasses found: {len(class_dirs)}")

    print("\n" + "-" * 60)
    print(f"{'CLASS':<15}{'IMAGES':>10}")
    print("-" * 60)

    total_images = 0

    for class_dir in class_dirs:

        image_files = [
            file
            for file in class_dir.iterdir()
            if file.is_file()
            and file.suffix.lower() in IMAGE_EXTENSIONS
        ]

        count = len(image_files)
        total_images += count

        print(
            f"{class_dir.name:<15}"
            f"{count:>10}"
        )

    print("-" * 60)
    print(f"{'TOTAL':<15}{total_images:>10}")
    print("-" * 60)

    print("\nDataset inspection complete.")


if __name__ == "__main__":
    main()