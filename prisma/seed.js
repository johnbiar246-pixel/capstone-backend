import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding categories...");

  const categories = [
    { id: "appetizers", name: "Appetizers" },
    { id: "main-dishes", name: "Main Dishes" },
    { id: "beers", name: "Beers" },
    { id: "spirits", name: "Spirits" },
    { id: "drinks", name: "Drinks" },
  ];

  for (const category of categories) {
    try {
      await prisma.category.upsert({
        where: { id: category.id },
        update: {},
        create: category,
      });
      console.log(`Created/verified category: ${category.name}`);
    } catch (error) {
      console.error(`Error with ${category.name}:`, error);
    }
  }

  console.log(" Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
