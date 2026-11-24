INSERT INTO books (slug,title,author,genre,synopsis,note,position) VALUES
('hill-house','The Haunting of Hill House','Shirley Jackson','Gothic horror','Four strangers arrive at a house with a long memory. For Eleanor, the invitation feels like a chance to belong. The house seems to agree.','Read it for the small cruelties around the breakfast table. By the time the walls start knocking, the house already feels alive.',1),
('willows','The Willows','Algernon Blackwood','Folk horror','A canoe trip on the Danube leaves two travelers stranded among shifting islands. As the river rises, the willows begin to move against the wind.','A slim book for a windy night. Blackwood makes the open sky feel every bit as confining as a locked room.',2),
('carmilla','Carmilla','Sheridan Le Fanu','Gothic horror','A carriage accident brings a captivating stranger to a secluded Styrian estate. Laura welcomes her new companion as a mysterious illness spreads through the countryside.','For readers who like their ghost stories intimate, languid and just a little too close for comfort.',3),
('king-in-yellow','The King in Yellow','Robert W. Chambers','Cosmic horror','A forbidden play winds through these strange tales of artists, troubled cities and a distant place called Carcosa. Some readers never return from its second act.','Try the opening stories in a single sitting. Tiny echoes between them make the whole city seem to share a fever.',4),
('frankenstein','Frankenstein','Mary Shelley','Gothic horror','Victor Frankenstein brings a creature to life and abandons it. Their pursuit of one another stretches from Alpine ice to the edge of the Arctic.','Come for the laboratory. Stay for the creature learning to read, watching a family through a crack in the wall.',5),
('turn-of-the-screw','The Turn of the Screw','Henry James','Psychological horror','A young governess takes charge of two children at an isolated country house. What she sees across the lake changes how she reads their every word.','Read with a friend. The smallest turn of a sentence can leave you imagining two very different houses.',6)
ON CONFLICT DO NOTHING;
INSERT INTO editions(sku,book_slug,format,price,on_hand) VALUES
('HILL-PB','hill-house','Paperback',1695,12),('HILL-HC','hill-house','Hardcover',2595,1),
('WILL-PB','willows','Paperback',1295,9),('CARM-HC','carmilla','Hardcover',2295,5),
('KING-PB','king-in-yellow','Paperback',1595,8),('FRAN-PB','frankenstein','Paperback',1495,11),
('FRAN-HC','frankenstein','Hardcover',2495,0),('TURN-PB','turn-of-the-screw','Paperback',1395,7)
ON CONFLICT DO NOTHING;
