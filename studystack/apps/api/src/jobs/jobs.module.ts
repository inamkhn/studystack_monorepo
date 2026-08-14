import { BullModule } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { Module } from "@nestjs/common";
import { INGESTION_QUEUE, MASTERY_DECAY_QUEUE, RESEARCH_QUEUE, STRUCTURING_QUEUE } from "./jobs.constants.js";
import { BackfillProcessor } from "./backfill.processor.js";
import { BackfillService } from "./backfill.service.js";
import { IngestionProcessor } from "./ingestion.processor.js";
import { MasteryDecayProcessor } from "./mastery-decay.processor.js";
import { StructuringProcessor } from "./structuring.processor.js";

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>("REDIS_URL", "redis://localhost:6379"),
        },
      }),
    }),
    BullModule.registerQueue(
      { name: INGESTION_QUEUE },
      { name: RESEARCH_QUEUE },
      { name: STRUCTURING_QUEUE },
      { name: MASTERY_DECAY_QUEUE },
    ),
  ],
  providers: [
    IngestionProcessor,
    BackfillProcessor,
    BackfillService,
    StructuringProcessor,
    MasteryDecayProcessor,
  ],
  exports: [BullModule, BackfillService],
})
export class JobsModule {}
